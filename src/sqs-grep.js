const fs = require('fs');
const os = require('os');
const path = require('path');
const chalk = require('chalk');
const AWS = require('aws-sdk');
const lineByLine = require('n-readlines');
const Bottleneck = require('bottleneck');
require('node-gzip');
const { validateOptions, printMatchingRules, parseOptions } = require('./options');

/**
 * Main sqs-grep executor class
 */
class SqsGrep {
    /**
     * Class constructor
     * @param {*} options sqs-grep options
     */
    constructor(options) {
        if (arguments.length > 1) {
            // Legacy constructor parameters: (sqs, options, log = console.log)
            options = arguments[1];
            options.sqs = arguments[0];
            options.log  = arguments[2];
        }
        // Merge with default options
        options = {
            ...parseOptions([]),
            ...options
        };
        const awsOptions = SqsGrep._getAwsOptions(options);
        this.options = options;
        this.sqs = options.sqs || new AWS.SQS(awsOptions);
        this.sns = options.sns || new AWS.SNS(awsOptions);
        this.log = options.log || console.log;
        this.running = false;
        this.emptyReceives = 0;
        this.qtyScanned = 0;
        this.qtyMatched = 0;
        this._configureThrottling();
        this.userScript = this._loadUserScript();
    }

    /**
     * Runs sqs-grep based on the passed constructor options
     * @returns {*} {qtyScanned, qtyMatched}
     */
    async run() {
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
        const keepRunning = () => this.running && new Date().getTime() < this.endAt && (this.options.maxMessages == 0 || this.qtyMatched < this.options.maxMessages);
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
                    for (let message of res.Messages) {
                        await this.userScript.preProcessMessage(message);
                        if (this._isMessageMatched(message)) {
                            this.qtyMatched++;
                            await this.userScript.preProcessMatchedMessage(message);
                            await this._processMatchedSqsMessage(message);
                            if (!keepRunning()) {
                                break;
                            }
                        }
                    }
                } catch (error) {
                    this.running = false;
                    throw error;
                }
            }
        });
        // Wait for all parallel executions to complete
        await Promise.all(promises);

        // Print the status
        this.log(chalk`\nMessages scanned: {green ${this.qtyScanned}}\nMessages matched: {green ${this.qtyMatched}}`);
        if (!this.running) this.log('Interrupted');
        else if (this.options.maxMessages && this.qtyMatched >= this.options.maxMessages) this.log('Done - Maximum number of messages matched');
        else if (new Date().getTime() < this.endAt) this.log('Done - Scanned the whole queue');
        else this.log(chalk`Time exceeded ({bold --timeout} is set to ${this.options.timeout.toFixed(1)} seconds)`);
        return {
            qtyScanned: this.qtyScanned,
            qtyMatched: this.qtyMatched,
        };
    }

    /**
     * Interrupts any currently ongoing execution
     */
    interrupt() {
        this.running = false;
    }

    /**
     * Configure throttling, if --maxTPS is set
     */
    _configureThrottling() {
        if (this.options.maxTPS && this.options.maxTPS > 0) {
            const minTime = parseInt(1000 / this.options.maxTPS);
            if (minTime > 0) {
                this.rate_limiter = new Bottleneck({ minTime });
                this._processMatchedSqsMessage = this.rate_limiter.wrap(this._processMatchedSqsMessage);
            }
        }
    }

    /**
     * Loads a custom user script, when --scriptFile is defined
     * @returns object with custom hooks (or default empty hooks)
     */
    _loadUserScript() {
        // Default to all empty hooks, when they are not defined
        const emptyHook = () => undefined;
        let hooks = {
            preProcessMessage: emptyHook,
            preProcessMatchedMessage: emptyHook,
        };
        if (this.options.scriptFile) {
            // This is just a trick to avoid 'pkg' complaining about dynamic requires
            const localRequire = require;
            const localResolve = require.resolve;

            // This function will require modules using the main entry point paths
            // which allows things like sqs_grep_require('node-gzip') in scripts
            global.sqs_grep_require = function (id) {
                return localRequire(localResolve(id, { paths: require.main.paths }));
            };

            const scriptFile = path.resolve(this.options.scriptFile);
            this.log(chalk`Loading user-provided script file '{green ${scriptFile}}' ...`);
            const scriptModule = localRequire(path.resolve(this.options.scriptFile));
            hooks = { ...hooks, ...scriptModule };
        }
        // Bind all hooks to this instance so they can do things like this.log('message')
        for (const key in hooks) {
            const element = hooks[key];
            if (typeof(element) === 'function') {
                hooks[key] = element.bind(this);
            }
        }
        return hooks;
    }

    /**
     * Retrieves AWS SDK options
     * @param {*} options sqs-grep options
     * @returns {Object} the AWS options based on command-line arguments
     */
    static _getAwsOptions(options) {
        const opts = {
            region: options.region,
            maxRetries: options.maxRetries,
        };
        if (options.accessKeyId) {
            opts.accessKeyId = options.accessKeyId;
        }
        if (options.secretAccessKey) {
            opts.secretAccessKey = options.secretAccessKey;
        }
        if (options.sessionToken) {
            opts.sessionToken = options.sessionToken;
        }
        if (options.endpointUrl) {
            opts.endpoint = new AWS.Endpoint(options.endpointUrl);
        }
        if (options.verbose) {
            opts.logger = { log: options.log || console.log };
        }
        return opts;
    }

    /**
     * Receives the next messages from the SQS queue
     */
    async _receiveMessage() {
        if (this.options.inputFile) {
            const message = this.inputFileReader.next();
            const Messages = message ? [JSON.parse(message)] : [];
            return { Messages };
        } else {
            const elapsedSeconds = parseInt((new Date().getTime() - this.startedAt) / 1000);
            const res = await this.sqs.receiveMessage({
                QueueUrl: this.options.sourceQueueUrl,
                MaxNumberOfMessages: 10,
                VisibilityTimeout: Math.max(1, this.options.timeout + 10 - elapsedSeconds),
                MessageAttributeNames: ['All'],
                AttributeNames: ['All'],
            }).promise();
            return res;
        }
    }

    /**
     * Connects to the given queue name or URL
     * @param {String} queue queue name or URL
     */
    async _connectToQueue(queue) {
        let queueUrl;
        if (/^\w+:\/\/.+$/.test(queue)) {
            this.log(chalk`Connecting to SQS queue URL '{green ${queue}}' ...`);
            queueUrl = queue;
        } else {
            this.log(chalk`Connecting to SQS queue '{green ${queue}}' in the '{green ${this.options.region}}' region...`);
            queueUrl = (await this.sqs.getQueueUrl({
                QueueName: queue,
            }).promise()).QueueUrl;
        }
        const queueAttributes = await this.sqs.getQueueAttributes({
            QueueUrl: queueUrl,
            AttributeNames: ['ApproximateNumberOfMessages']
        }).promise();
        this.log(chalk`This queue has approximately {green ${queueAttributes.Attributes.ApproximateNumberOfMessages}} messages at the moment.`);
        return queueUrl;
    }

    /**
     * Finds the URL of the source queue for a given DLQ
     * @param {String} dlqUrl URL of the DLQ
     */
    async _findDlqSourceQueue(dlqUrl) {
        this.log(chalk`Finding the dead-letter source queue of '{green ${dlqUrl}}' ...`);
        const res = await this.sqs.listDeadLetterSourceQueues({
            QueueUrl: dlqUrl,
            MaxResults: 1000,
        }).promise();
        const urls = res.queueUrls || [];
        if (urls.length !== 1) {
            const msg = urls.length === 0
                ? `ERROR - Could not find source queue for dead-letter ${dlqUrl}`
                : `ERROR - Found a total of ${urls.length} source queues for dead-letter ${dlqUrl} but --redrive supports only exactly one source queue`;
            this.log(chalk`{bold {red ${msg}}}`);
            throw new Error(msg);
        }
        const queueUrl = urls[0];
        this.log(chalk`Found dead-letter source: '{green ${queueUrl}}' ...`);
        return queueUrl;
    }

    /**
     * Connects to all required SQS queues by retrieving their URL
     */
    async _connectToQueues() {
        if  (this.options.inputFile) {
            this.inputFileReader = new lineByLine(this.options.inputFile);
        } else {
            this.options.sourceQueueUrl = await this._connectToQueue(this.options.queue);
        }
        if (this.options.redrive) {
            this.options.moveTo = await this._findDlqSourceQueue(this.options.sourceQueueUrl);
        }
        if (this.options.moveTo) {
            this.options.moveToQueueUrl = await this._connectToQueue(this.options.moveTo);
        }
        if (this.options.copyTo) {
            this.options.copyToQueueUrl = await this._connectToQueue(this.options.copyTo);
        }
        if (this.options.publishTo) {
            this.log(chalk`Connecting to target SNS topic '{green ${this.options.publishTo}}' in the '{green ${this.options.region}}' region...`);
            await this.sns.getTopicAttributes({
                TopicArn: this.options.publishTo,
            }).promise();
        }
    }

    /**
     * Checks if a message matches the options received
     * @param {Object} message SQS message
     * @returns {Boolean} true if it matches
     */
    _isMessageMatched(message) {
        const options = this.options;
        if (options.all) {
            return true;
        }
        if (options.body && this.negate(options.body.test(message.Body))) {
            return true;
        }
        // Check if message any attributes match
        if (options.attribute && message.MessageAttributes) {
            for (let attribute of options.attribute) {
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
     * @param {Object} message SQS message
     */
    _printSqsMessage(message) {
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
                fs.appendFile(options.outputFile, content + os.EOL, {encoding: 'utf-8'}, err => {
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
     * @param {Object} message SQS message
     */
    async _processMatchedSqsMessage(message) {
        await this._printSqsMessage(message);
        const options = this.options;
        if (options.moveTo || options.copyTo || options.publishTo || options.republish) {
            if (!options.stripAttributes && message.MessageAttributes) {
                // Remove parameter values not supported yet
                for (let key in message.MessageAttributes) {
                    delete message.MessageAttributes[key].StringListValues;
                    delete message.MessageAttributes[key].BinaryListValues;
                }
            }
            // Copy the message to the target queues
            const targetUrls = [options.moveToQueueUrl, options.copyToQueueUrl].filter(url => url);
            for (let url of targetUrls) {
                const fifoAttributes = !url.endsWith('.fifo') ? {} : {
                    MessageGroupId: message.Attributes.MessageGroupId || 'fifo',
                    MessageDeduplicationId: message.Attributes.MessageDeduplicationId || message.MessageId,
                };
                await this.sqs.sendMessage({
                    QueueUrl: url,
                    MessageBody: message.Body,
                    MessageAttributes: options.stripAttributes ? null : message.MessageAttributes,
                    ...fifoAttributes
                }).promise();
            }
            // Publish the message to the target topic
            if (options.publishTo) {
                await this.sns.publish({
                    TopicArn: options.publishTo,
                    Message: this._getBodyToPublish(message),
                    MessageAttributes: options.stripAttributes ? null : this._getMessageAttributesToPublish(message),
                }).promise();
            }
            // Republish message to it's topic of origin
            if (options.republish) {
                try {
                    const notification = JSON.parse(message.Body);
                    if (notification.Type === 'Notification' && notification.Message && notification.TopicArn) {
                        const messageAttributes = notification.MessageAttributes;
                        await this.sns.publish({
                            TopicArn: notification.TopicArn,
                            Message: notification.Message,
                            MessageAttributes: options.stripAttributes ? null : this._getSnsMessageAttributeFromSqs(messageAttributes),
                        }).promise();
                    }
                } catch (err) {
                    // ignore
                }
            }
        }
        if (options.delete || options.moveTo) {
            // Delete the source message
            await this.sqs.deleteMessage({
                QueueUrl: options.sourceQueueUrl,
                ReceiptHandle: message.ReceiptHandle
            }).promise();
        }
    }

    /**
     * When options.negate is set, this function will invert the boolean
     * value received - otherwise it does nothing.
     * @param {Boolean} b boolean to invert
     * @returns {Boolean} boolean value to use (negated or not)
     */
    negate(b) {
        return this.options.negate ? !b : !!b;
    }

    /**
     * Executes a function a number of times and return an array with all the results
     * @param {Number} times number of times to run the function
     * @param {function} fn function to run
     * @returns {Array} array of results
     */
    _nTimes(times, fn) {
        const res = [];
        for (let i = 0; i < times; i++) {
            res.push(fn());
        }
        return res;
    }

    /**
     * Gets the message body to publish on SNS, given an SQS message
     * @param {*} message SQS message
     */
    _getBodyToPublish(message) {
        let body = message.Body;
        // Check if this is already an SNS message to avoid "double-wrapping" it
        try {
            const notification = JSON.parse(body);
            if (notification.Type === 'Notification' && notification.Message) {
                body = notification.Message;
            }
        } catch (ex) {
            // ignore
        }
        return body;
    }

    /**
     * Gets the message attributes to publish on SNS, given an SQS message
     * @param {*} message SQS message
     */
    _getMessageAttributesToPublish(message) {
        let messageAttributes = message.MessageAttributes;
        try {
            const notification = JSON.parse(message.Body);
            if (notification.Type === 'Notification' && notification.MessageAttributes) {
                messageAttributes = this._getSnsMessageAttributeFromSqs(notification.MessageAttributes);
            }
        } catch (ex) {
            // ignore
        }
        return messageAttributes;
    }

    /**
     * Gets SNS message attributes given SQS message attributes
     * @param {*} sqsMessageAttribute SQS message attributes
     */
    _getSnsMessageAttributeFromSqs(sqsMessageAttribute) {
        if (!sqsMessageAttribute) {
            return null;
        }
        let messageAttributes = {};
        for (let attributeEntry in sqsMessageAttribute) {
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
     * @param {Number} ms milliseconds
     */
    _delay(ms) {
        return new Promise(resolve => setTimeout(() => resolve(), ms));
    }
}

module.exports = { SqsGrep };
