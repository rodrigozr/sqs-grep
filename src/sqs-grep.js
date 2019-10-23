const fs = require('fs');
const os = require('os');
const chalk = require('chalk');
const AWS = require('aws-sdk');
const {validateOptions, printMatchingRules, parseOptions} = require('./options');

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
    }

    /**
     * Runs sqs-grep based on the passed constructor options
     * @returns {*} {qtyScanned, qtyMatched}
     */
    async run() {
        const options = this.options;
        if (!validateOptions(options, this.log)) {
            return null;
        }
        await this._connectToQueues();
        printMatchingRules(options, this.log);

        const startedAt = new Date().getTime();
        const endAt = startedAt + options.timeout * 1000;
        this.emptyReceives = 0;
        this.running = true;
        this.qtyScanned = 0;
        this.qtyMatched = 0;
        const keepRunning = () => this.running && new Date().getTime() < endAt && (options.maxMessages == 0 || this.qtyMatched < options.maxMessages);
        this.log('Scanning...');
        const promises = this._nTimes(options.parallel, async () => {
            while (keepRunning()) {
                try {
                    const elapsedSeconds = parseInt((new Date().getTime() - startedAt) / 1000);
                    const res = await this.sqs.receiveMessage({
                        QueueUrl: options.sourceQueueUrl,
                        MaxNumberOfMessages: 10,
                        VisibilityTimeout: Math.max(1, options.timeout + 10 - elapsedSeconds),
                        MessageAttributeNames: ['All'],
                    }).promise();
                    if (!res.Messages || !res.Messages.length) {
                        if (++this.emptyReceives < 5) {
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
                        if (this._isMessageMatched(message)) {
                            this.qtyMatched++;
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
        else if (options.maxMessages && this.qtyMatched >= options.maxMessages) this.log('Done - Maximum number of messages matched');
        else if (new Date().getTime() < endAt) this.log('Done - Scanned the whole queue');
        else this.log('Time exceeded');
        return {
            qtyScanned: this.qtyScanned,
            qtyMatched: this.qtyMatched,
        }
    }

    /**
     * Interrupts any currently ongoing execution
     */
    interrupt() {
        this.running = false;
    }

    /**
     * Retrieves AWS SDK options
     * @param {*} options sqs-grep options
     * @returns {Object} the AWS options based on command-line arguments
     */
    static _getAwsOptions(options) {
        const opts = {
            region: options.region
        };
        if (options.accessKeyId) {
            opts.accessKeyId = options.accessKeyId;
        }
        if (options.secretAccessKey) {
            opts.secretAccessKey = options.secretAccessKey;
        }
        if (options.endpointUrl) {
            opts.endpoint = new AWS.Endpoint(options.endpointUrl);
        }
        return opts;
    }

    /**
     * Connects to all required SQS queues by retrieving their URL
     */
    async _connectToQueues() {
        this.log(chalk`Connecting to SQS queue '{green ${this.options.queue}}' in the '{green ${this.options.region}}' region...`);
        this.options.sourceQueueUrl = (await this.sqs.getQueueUrl({
            QueueName: this.options.queue,
        }).promise()).QueueUrl;
        const queueAttributes = await this.sqs.getQueueAttributes({
            QueueUrl: this.options.sourceQueueUrl,
            AttributeNames: ['ApproximateNumberOfMessages']
        }).promise();
        this.log(chalk`This queue has approximately {green ${queueAttributes.Attributes.ApproximateNumberOfMessages}} messages at the moment.`);
        if (this.options.moveTo) {
            this.log(chalk`Connecting to target SQS queue '{green ${this.options.moveTo}}' in the '{green ${this.options.region}}' region...`);
            this.options.moveToQueueUrl = (await this.sqs.getQueueUrl({
                QueueName: this.options.moveTo,
            }).promise()).QueueUrl;
        }
        if (this.options.copyTo) {
            this.log(chalk`Connecting to target SQS queue '{green ${this.options.copyTo}}' in the '{green ${this.options.region}}' region...`);
            this.options.copyToQueueUrl = (await this.sqs.getQueueUrl({
                QueueName: this.options.copyTo,
            }).promise()).QueueUrl;
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
            MessageAttributes: message.MessageAttributes
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
                await this.sqs.sendMessage({
                    QueueUrl: url,
                    MessageBody: message.Body,
                    MessageAttributes: options.stripAttributes ? null : message.MessageAttributes,
                }).promise();
            }
            // Publish the message to the target topic
            if (options.publishTo) {
                await this.sns.publish({
                    TopicArn: options.publishTo,
                    Message: this._getBodyToPublish(message),
                    MessageAttributes: options.stripAttributes ? null : message.MessageAttributes,
                }).promise();
            }
            // Republish message to it's topic of origin
            if (options.republish) {
                try {
                    const notification = JSON.parse(message.Body);
                    if (notification.Type === 'Notification' && notification.Message && notification.TopicArn) {
                        await this.sns.publish({
                            TopicArn: notification.TopicArn,
                            Message: notification.Message,
                            MessageAttributes: options.stripAttributes ? null : message.MessageAttributes,
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
}

module.exports = { SqsGrep };
