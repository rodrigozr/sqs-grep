import fs from 'fs';
import {EOL} from 'os';
import {resolve as resolvePath} from 'path';
import {createRequire} from 'module';
import chalk from 'chalk';
import {SNS, type SNSClientConfig, type MessageAttributeValue as SnsMessageAttributeValue} from '@aws-sdk/client-sns';
import {SQS, type SQSClientConfig, type Message, type ReceiveMessageResult} from '@aws-sdk/client-sqs';
import LineByLine from 'n-readlines';
import Bottleneck from 'bottleneck';
import {validateOptions, printMatchingRules, parseOptions, type SqsGrepOptions} from './options.js';
import {StateFile} from './state-file.js';
import type {Logger, SqsClient, SnsClient} from './types.js';

/**
 * Symbol used to attach the 1-based index of a message read from an --inputFile,
 * without polluting the message object itself (which may be sent to SQS/SNS or
 * inspected by user scripts).
 */
export const MESSAGE_INDEX: unique symbol = Symbol('sqsGrepMessageIndex');

/**
 * An SQS message as handled by sqs-grep. When read from an --inputFile, it also
 * carries its position in the file under the {@link MESSAGE_INDEX} symbol.
 */
export interface SqsGrepMessage extends Message {
    [MESSAGE_INDEX]?: number;
}

/**
 * Hooks which can be implemented by user-provided scripts (see user-scripts.md).
 * Hooks are bound to the running {@link SqsGrep} instance, so `this.log(...)`
 * works inside them. Both synchronous and asynchronous hooks are supported.
 */
export interface UserScriptHooks {
    /** Called for every message received, before matching it against the options */
    preProcessMessage(message: SqsGrepMessage): void | Promise<void>;
    /** Called for every matched message, before it is printed / copied / moved / published */
    preProcessMatchedMessage(message: SqsGrepMessage): void | Promise<void>;
}

/**
 * Shape of a user-provided script module (see user-scripts.md). All hooks are
 * optional, and `this` inside them is the running {@link SqsGrep} instance.
 *
 * Scripts written in TypeScript can use it as `export = {...} satisfies UserScript`.
 */
export type UserScript = Partial<UserScriptHooks> & ThisType<SqsGrep>;

/**
 * Result of an sqs-grep execution
 */
export interface SqsGrepResult {
    /** Total number of messages scanned */
    qtyScanned: number;
    /** Total number of messages matched */
    qtyMatched: number;
}

/**
 * Relevant parts of an SNS notification delivered to an SQS queue
 */
interface SnsNotification {
    Type?: string;
    Message?: string;
    TopicArn?: string;
    MessageAttributes?: Record<string, {Type: string; Value: string}>;
}

declare global {
    /**
     * Made available to user-provided scripts so that they can require modules
     * bundled with sqs-grep (for example `sqs_grep_require('node-gzip')`).
     */
    var sqs_grep_require: ((id: string) => unknown) | undefined;
}

/**
 * Main sqs-grep executor class
 */
export class SqsGrep {
    readonly options: SqsGrepOptions;
    readonly sqs: SqsClient;
    readonly sns: SnsClient;
    readonly log: Logger;
    running = false;
    emptyReceives = 0;
    qtyScanned = 0;
    qtyMatched = 0;
    messageIndex = 0;
    stateFile: StateFile | null = null;
    startedAt = 0;
    endAt = 0;
    rate_limiter?: Bottleneck;
    inputFileReader?: LineByLine;
    readonly userScript: UserScriptHooks;

    /**
     * Class constructor
     * @param options sqs-grep options
     */
    constructor(options: Partial<SqsGrepOptions>);
    /**
     * Legacy class constructor
     * @param sqs SQS client to use
     * @param options sqs-grep options
     * @param log logger to use
     * @deprecated pass `sqs` and `log` as part of `options` instead
     */
    constructor(sqs: SqsClient, options: Partial<SqsGrepOptions>, log?: Logger);
    constructor(...args: [Partial<SqsGrepOptions>] | [SqsClient, Partial<SqsGrepOptions>, Logger?]) {
        const options: Partial<SqsGrepOptions> = SqsGrep._isLegacyConstructorCall(args)
            // Legacy constructor parameters: (sqs, options, log = console.log)
            ? {...args[1], sqs: args[0], log: args[2]}
            : args[0];
        // Merge with default options
        this.options = {
            ...parseOptions([]),
            ...options
        };
        const awsOptions = SqsGrep._getAwsOptions(this.options);
        this.sqs = this.options.sqs || new SQS(awsOptions);
        this.sns = this.options.sns || new SNS(awsOptions);
        this.log = this.options.log || console.log;
        this._configureThrottling();
        this.userScript = this._loadUserScript();
    }

    /**
     * Runs sqs-grep based on the passed constructor options
     * @returns the execution result, or `null` when the options are invalid
     */
    async run(): Promise<SqsGrepResult | null> {
        if (!validateOptions(this.options, this.log)) {
            return null;
        }
        await this._connectToQueues();
        printMatchingRules(this.options, this.log);

        this.startedAt = new Date().getTime();
        this.endAt = this.startedAt + this.options.timeout * 1000;
        this.emptyReceives = 0;
        this.running = true;
        this.qtyScanned = 0;
        this.qtyMatched = 0;
        const keepRunning = (): boolean => this.running && new Date().getTime() < this.endAt && (this.options.maxMessages == 0 || this.qtyMatched < this.options.maxMessages);
        this.log('Scanning...');
        const promises = this._nTimes(this.options.parallel, async () => {
            while (keepRunning()) {
                try {
                    const res = await this._receiveMessage();
                    if (!res.Messages || !res.Messages.length) {
                        // Handle "empty receives"
                        if (++this.emptyReceives < this.options.emptyReceives) {
                            if (this.options.wait > 0) {
                                await this._delay(this.options.wait * 1000);
                            }
                            continue;
                        } else {
                            break;
                        }
                    }
                    this.emptyReceives = 0;
                    this.qtyScanned += res.Messages.length;
                    if (!keepRunning()) {
                        break;
                    }
                    // Process received messages
                    for (const message of res.Messages as SqsGrepMessage[]) {
                        await this.userScript.preProcessMessage(message);
                        const matched = this._isMessageMatched(message);
                        if (matched) {
                            this.qtyMatched++;
                            await this.userScript.preProcessMatchedMessage(message);
                            await this._processMatchedSqsMessage(message);
                        }
                        // The message is fully processed at this point, so it does
                        // not need to be scanned again by a resumed execution
                        this._markMessageProcessed(message);
                        if (matched && !keepRunning()) {
                            break;
                        }
                    }
                } catch (error) {
                    this.running = false;
                    throw error;
                }
            }
        });
        // Wait for all parallel executions to complete
        try {
            await Promise.all(promises);
        } finally {
            this._saveAndLogState();
        }

        // Print the status
        this.log(`\nMessages scanned: ${chalk.green(this.qtyScanned)}\nMessages matched: ${chalk.green(this.qtyMatched)}`);
        if (!this.running) this.log('Interrupted');
        else if (this.options.maxMessages && this.qtyMatched >= this.options.maxMessages) this.log('Done - Maximum number of messages matched');
        else if (new Date().getTime() < this.endAt) this.log('Done - Scanned the whole queue');
        else this.log(`Time exceeded (${chalk.bold(`--timeout`)} is set to ${this.options.timeout.toFixed(1)} seconds)`);
        return {
            qtyScanned: this.qtyScanned,
            qtyMatched: this.qtyMatched,
        };
    }

    /**
     * Interrupts any currently ongoing execution
     */
    interrupt(): void {
        this.running = false;
        // Persist the progress right away, as we may not have the chance later.
        // This is silent on purpose: the resume point is logged once, at the end
        // of the execution.
        if (this.stateFile) {
            this.stateFile.save();
        }
    }

    /**
     * Marks a message read from an --inputFile as fully processed, so that a
     * future execution using the same --stateFile can skip it
     * @param message message which was processed
     * @internal
     */
    _markMessageProcessed(message: SqsGrepMessage): void {
        if (this.stateFile) {
            this.stateFile.markProcessed(message[MESSAGE_INDEX]);
        }
    }

    /**
     * Saves the --stateFile, when it is enabled, and logs the resume point.
     *
     * The log does not depend on this specific call having written to disk, as
     * the progress may have already been saved by a periodic save.
     * @internal
     */
    _saveAndLogState(): void {
        if (!this.stateFile) {
            return;
        }
        this.stateFile.save();
        if (this.stateFile.lastProcessedIndex > 0) {
            this.log(`Progress saved to '${chalk.green(this.options.stateFile)}' (last processed message: ${chalk.green(this.stateFile.lastProcessedIndex)}).`);
        }
    }

    /**
     * Configure throttling, if --maxTPS is set
     * @internal
     */
    _configureThrottling(): void {
        if (this.options.maxTPS && this.options.maxTPS > 0) {
            const minTime = Math.trunc(1000 / this.options.maxTPS);
            if (minTime > 0) {
                this.rate_limiter = new Bottleneck({ minTime });
                this._processMatchedSqsMessage = this.rate_limiter.wrap(this._processMatchedSqsMessage.bind(this));
            }
        }
    }

    /**
     * Loads a custom user script, when --scriptFile is defined.
     *
     * User scripts are plain CommonJS modules (see user-scripts.md). sqs-grep itself
     * is an ES module, so they are loaded through `module.createRequire()`, which
     * gives us a fully functional `require()`. On Node.js 22.12+ that `require()`
     * can also load scripts written as ES modules.
     * @returns object with custom hooks (or default empty hooks)
     * @internal
     */
    _loadUserScript(): UserScriptHooks {
        // Default to all empty hooks, when they are not defined
        const emptyHook = (): void => undefined;
        let hooks: Record<string, unknown> = {
            preProcessMessage: emptyHook,
            preProcessMatchedMessage: emptyHook,
        };
        if (this.options.scriptFile) {
            // Resolves modules from sqs-grep's own location, which allows scripts to
            // load modules bundled with sqs-grep: sqs_grep_require('node-gzip')
            const requireFromSqsGrep = createRequire(import.meta.url);
            global.sqs_grep_require = (id: string): unknown => requireFromSqsGrep(id) as unknown;

            const scriptFile = resolvePath(this.options.scriptFile);
            this.log(`Loading user-provided script file '${chalk.green(scriptFile)}' ...`);
            const scriptModule = SqsGrep._unwrapScriptModule(requireFromSqsGrep(scriptFile));
            hooks = { ...hooks, ...scriptModule };
        }
        // Bind all hooks to this instance so they can do things like this.log('message')
        for (const key in hooks) {
            const element = hooks[key];
            if (typeof element === 'function') {
                hooks[key] = element.bind(this);
            }
        }
        return hooks as unknown as UserScriptHooks;
    }

    /**
     * Normalises a loaded user-script module into its hooks object.
     *
     * A CommonJS script exports the hooks directly (`module.exports = {...}`), while
     * an ES module script exports them as its default export, which `require()`
     * surfaces as the `default` property of the module namespace.
     * @param loaded whatever `require()` returned for the script
     * @returns the hooks object
     * @internal
     */
    static _unwrapScriptModule(loaded: unknown): Record<string, unknown> {
        if (loaded === null || typeof loaded !== 'object') {
            return {};
        }
        const record = loaded as Record<string, unknown>;
        const isEsModule = record[Symbol.toStringTag as unknown as string] === 'Module' || record.__esModule === true;
        if (isEsModule && record.default !== null && typeof record.default === 'object') {
            return record.default as Record<string, unknown>;
        }
        return record;
    }

    /**
     * Tells the legacy `(sqs, options, log)` constructor call apart from `(options)`
     * @param args constructor arguments
     * @internal
     */
    static _isLegacyConstructorCall(
        args: [Partial<SqsGrepOptions>] | [SqsClient, Partial<SqsGrepOptions>, Logger?]
    ): args is [SqsClient, Partial<SqsGrepOptions>, Logger?] {
        return args.length > 1;
    }

    /**
     * Retrieves AWS SDK options
     * @param options sqs-grep options
     * @returns the AWS client configuration based on command-line arguments
     * @internal
     */
    static _getAwsOptions(options: SqsGrepOptions): SQSClientConfig & SNSClientConfig {
        const opts: SQSClientConfig & SNSClientConfig = {
            region: options.region,
            // --maxRetries counts retries, while the SDK counts attempts (which include the first call)
            maxAttempts: options.maxRetries + 1,
        };
        if (options.accessKeyId && options.secretAccessKey) {
            opts.credentials = {
                accessKeyId: options.accessKeyId,
                secretAccessKey: options.secretAccessKey,
                sessionToken: options.sessionToken,
            };
        }
        if (options.endpointUrl) {
            opts.endpoint = options.endpointUrl;
        }
        if (options.verbose) {
            const log = options.log || console.log;
            opts.logger = {
                // The SDK logs every API call (with its input and output) at 'info' level.
                // 'debug' is intentionally silenced as it is too noisy to be useful here.
                debug: () => undefined,
                info: log,
                warn: log,
                error: log,
            };
        }
        return opts;
    }

    /**
     * Receives the next messages from the SQS queue
     * @internal
     */
    async _receiveMessage(): Promise<ReceiveMessageResult> {
        if (this.options.inputFile) {
            const line = this.inputFileReader!.next();
            if (!line) {
                return { Messages: [] };
            }
            const parsedMessage = JSON.parse(line.toString()) as SqsGrepMessage;
            // Note: there is no 'await' before this increment, so it is atomic
            // even when multiple parallel pollers are running
            parsedMessage[MESSAGE_INDEX] = ++this.messageIndex;
            return { Messages: [parsedMessage] };
        } else {
            const elapsedSeconds = Math.trunc((new Date().getTime() - this.startedAt) / 1000);
            const res = await this.sqs.receiveMessage({
                QueueUrl: this.options.sourceQueueUrl,
                MaxNumberOfMessages: 10,
                VisibilityTimeout: Math.max(1, this.options.timeout + 10 - elapsedSeconds),
                MessageAttributeNames: ['All'],
                MessageSystemAttributeNames: ['All'],
            });
            return res;
        }
    }

    /**
     * Connects to the given queue name or URL
     * @param queue queue name or URL
     * @returns the queue URL
     * @internal
     */
    async _connectToQueue(queue: string): Promise<string> {
        let queueUrl: string;
        if (/^\w+:\/\/.+$/.test(queue)) {
            this.log(`Connecting to SQS queue URL '${chalk.green(queue)}' ...`);
            queueUrl = queue;
        } else {
            this.log(`Connecting to SQS queue '${chalk.green(queue)}' in the '${chalk.green(this.options.region)}' region...`);
            queueUrl = (await this.sqs.getQueueUrl({
                QueueName: queue,
            })).QueueUrl!;
        }
        const queueAttributes = await this.sqs.getQueueAttributes({
            QueueUrl: queueUrl,
            AttributeNames: ['ApproximateNumberOfMessages']
        });
        this.log(`This queue has approximately ${chalk.green(queueAttributes.Attributes?.ApproximateNumberOfMessages)} messages at the moment.`);
        return queueUrl;
    }

    /**
     * Finds the URL of the source queue for a given DLQ
     * @param dlqUrl URL of the DLQ
     * @returns the source queue URL
     * @internal
     */
    async _findDlqSourceQueue(dlqUrl: string): Promise<string> {
        this.log(`Finding the dead-letter source queue of '${chalk.green(dlqUrl)}' ...`);
        const res = await this.sqs.listDeadLetterSourceQueues({
            QueueUrl: dlqUrl,
            MaxResults: 1000,
        });
        const urls = res.queueUrls || [];
        if (urls.length !== 1) {
            const msg = urls.length === 0
                ? `ERROR - Could not find source queue for dead-letter ${dlqUrl}`
                : `ERROR - Found a total of ${urls.length} source queues for dead-letter ${dlqUrl} but --redrive supports only exactly one source queue`;
            this.log(chalk.bold(chalk.red(msg)));
            throw new Error(msg);
        }
        const queueUrl = urls[0];
        this.log(`Found dead-letter source: '${chalk.green(queueUrl)}' ...`);
        return queueUrl;
    }

    /**
     * Connects to all required SQS queues by retrieving their URL
     * @internal
     */
    async _connectToQueues(): Promise<void> {
        if (this.options.inputFile) {
            this.inputFileReader = new LineByLine(this.options.inputFile);
            this.messageIndex = 0;
            this._resumeFromStateFile();
        } else {
            this.options.sourceQueueUrl = await this._connectToQueue(this.options.queue!);
        }
        if (this.options.redrive) {
            this.options.moveTo = await this._findDlqSourceQueue(this.options.sourceQueueUrl!);
        }
        if (this.options.moveTo) {
            this.options.moveToQueueUrl = await this._connectToQueue(this.options.moveTo);
        }
        if (this.options.copyTo) {
            this.options.copyToQueueUrl = await this._connectToQueue(this.options.copyTo);
        }
        if (this.options.publishTo) {
            this.log(`Connecting to target SNS topic '${chalk.green(this.options.publishTo)}' in the '${chalk.green(this.options.region)}' region...`);
            await this.sns.getTopicAttributes({
                TopicArn: this.options.publishTo,
            });
        }
    }

    /**
     * Initializes the --stateFile (when set) and skips all messages from the
     * --inputFile which were already processed by a previous execution
     * @internal
     */
    _resumeFromStateFile(): void {
        if (!this.options.stateFile) {
            return;
        }
        this.stateFile = new StateFile({
            filePath: this.options.stateFile,
            inputFile: this.options.inputFile,
            flushInterval: this.options.stateFileInterval,
            log: this.log,
        });
        const resumeFrom = this.stateFile.load();
        if (!resumeFrom) {
            return;
        }
        this.log(`Resuming from message ${chalk.green(resumeFrom + 1)} - skipping the first ${chalk.green(resumeFrom)} message(s) already processed...`);
        let skipped = 0;
        while (skipped < resumeFrom && this.inputFileReader!.next()) {
            skipped++;
        }
        if (skipped < resumeFrom) {
            this.log(chalk.yellow(`WARNING: The input file only contains ${skipped} message(s), but the state file says that ${resumeFrom} were already processed.`));
        }
        this.messageIndex = skipped;
    }

    /**
     * Checks if a message matches the options received
     * @param message SQS message
     * @returns true if it matches
     * @internal
     */
    _isMessageMatched(message: SqsGrepMessage): boolean {
        const options = this.options;
        if (options.all) {
            return true;
        }
        if (options.body && this.negate(options.body.test(message.Body ?? ''))) {
            return true;
        }
        // Check if message any attributes match
        if (options.attribute && message.MessageAttributes) {
            for (const attribute of options.attribute) {
                const messageAttribute = message.MessageAttributes[attribute.attr];
                if (messageAttribute && messageAttribute.StringValue && this.negate(attribute.regexp.test(messageAttribute.StringValue))) {
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * Prints an SQS message to the console, based on the options
     * @param message SQS message
     * @internal
     */
    _printSqsMessage(message: SqsGrepMessage): Promise<void> | void {
        const options = this.options;
        if (options.silent) {
            return;
        }
        const content = options.full ? JSON.stringify({
            Body: message.Body,
            MessageAttributes: message.MessageAttributes,
            Attributes: message.Attributes,
        }) : message.Body;

        if (options.outputFile) {
            return new Promise((resolve, reject) => {
                fs.appendFile(options.outputFile!, content + EOL, {encoding: 'utf-8'}, err => {
                    if (err) reject(err);
                    else resolve();
                });
            });
        } else {
            this.log(content);
        }
    }

    /**
     * Process a matched SQS message
     * @param message SQS message
     * @internal
     */
    async _processMatchedSqsMessage(message: SqsGrepMessage): Promise<void> {
        await this._printSqsMessage(message);
        const options = this.options;
        if (options.moveTo || options.copyTo || options.publishTo || options.republish) {
            if (!options.stripAttributes && message.MessageAttributes) {
                // Remove parameter values not supported yet
                for (const key in message.MessageAttributes) {
                    delete message.MessageAttributes[key].StringListValues;
                    delete message.MessageAttributes[key].BinaryListValues;
                }
            }
            // Copy the message to the target queues
            const targetUrls = [options.moveToQueueUrl, options.copyToQueueUrl].filter((url): url is string => !!url);
            for (const url of targetUrls) {
                const fifoAttributes = !url.endsWith('.fifo') ? {} : {
                    MessageGroupId: message.Attributes?.MessageGroupId || 'fifo',
                    MessageDeduplicationId: message.Attributes?.MessageDeduplicationId || message.MessageId,
                };
                await this.sqs.sendMessage({
                    QueueUrl: url,
                    MessageBody: message.Body,
                    MessageAttributes: options.stripAttributes ? undefined : message.MessageAttributes,
                    ...fifoAttributes
                });
            }
            // Publish the message to the target topic
            if (options.publishTo) {
                await this.sns.publish({
                    TopicArn: options.publishTo,
                    Message: this._getBodyToPublish(message),
                    MessageAttributes: options.stripAttributes ? undefined : this._getMessageAttributesToPublish(message),
                });
            }
            // Republish message to it's topic of origin
            if (options.republish) {
                try {
                    const notification = JSON.parse(message.Body ?? '') as SnsNotification;
                    if (notification.Type === 'Notification' && notification.Message && notification.TopicArn) {
                        const messageAttributes = notification.MessageAttributes;
                        await this.sns.publish({
                            TopicArn: notification.TopicArn,
                            Message: notification.Message,
                            MessageAttributes: options.stripAttributes ? undefined : this._getSnsMessageAttributeFromSqs(messageAttributes),
                        });
                    }
                } catch {
                    // ignore
                }
            }
        }
        if (options.delete || options.moveTo) {
            // Delete the source message
            await this.sqs.deleteMessage({
                QueueUrl: options.sourceQueueUrl,
                ReceiptHandle: message.ReceiptHandle
            });
        }
    }

    /**
     * When options.negate is set, this function will invert the boolean
     * value received - otherwise it does nothing.
     * @param b boolean to invert
     * @returns boolean value to use (negated or not)
     */
    negate(b: boolean): boolean {
        return this.options.negate ? !b : b;
    }

    /**
     * Executes a function a number of times and return an array with all the results
     * @param times number of times to run the function
     * @param fn function to run
     * @returns array of results
     * @internal
     */
    _nTimes<T>(times: number, fn: () => T): T[] {
        const res: T[] = [];
        for (let i = 0; i < times; i++) {
            res.push(fn());
        }
        return res;
    }

    /**
     * Gets the message body to publish on SNS, given an SQS message
     * @param message SQS message
     * @internal
     */
    _getBodyToPublish(message: SqsGrepMessage): string | undefined {
        let body = message.Body;
        // Check if this is already an SNS message to avoid "double-wrapping" it
        try {
            const notification = JSON.parse(body ?? '') as SnsNotification;
            if (notification.Type === 'Notification' && notification.Message) {
                body = notification.Message;
            }
        } catch {
            // ignore
        }
        return body;
    }

    /**
     * Gets the message attributes to publish on SNS, given an SQS message
     * @param message SQS message
     * @internal
     */
    _getMessageAttributesToPublish(message: SqsGrepMessage): Record<string, SnsMessageAttributeValue> | undefined {
        let messageAttributes: Record<string, SnsMessageAttributeValue> | undefined = message.MessageAttributes;
        try {
            const notification = JSON.parse(message.Body ?? '') as SnsNotification;
            if (notification.Type === 'Notification' && notification.MessageAttributes) {
                messageAttributes = this._getSnsMessageAttributeFromSqs(notification.MessageAttributes);
            }
        } catch {
            // ignore
        }
        return messageAttributes;
    }

    /**
     * Gets SNS message attributes given the message attributes of an SNS notification
     * @param sqsMessageAttribute message attributes as found in an SNS notification body
     * @internal
     */
    _getSnsMessageAttributeFromSqs(sqsMessageAttribute: SnsNotification['MessageAttributes'] | null): Record<string, SnsMessageAttributeValue> | undefined {
        if (!sqsMessageAttribute) {
            return undefined;
        }
        const messageAttributes: Record<string, SnsMessageAttributeValue> = {};
        for (const attributeEntry in sqsMessageAttribute) {
            const { Type, Value } = sqsMessageAttribute[attributeEntry];
            messageAttributes[attributeEntry] = {
                'DataType': Type,
                'StringValue': Value
            };
        }
        return messageAttributes;
    }

    /**
     * Returns a promise which resolves after the given number of milliseconds
     * @param ms milliseconds
     * @internal
     */
    _delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(() => resolve(), ms));
    }
}
