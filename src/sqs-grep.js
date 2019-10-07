const fs = require('fs');
const os = require('os');
const chalk = require('chalk');
const {validateOptions, printMatchingRules} = require('./options');

/**
 * Main sqs-grep executor class
 */
class SqsGrep {
    /**
     * Class constructor
     * @param {AWS:SQS} sqs sqs queue SDK instance
     * @param {*} options sqs-grep options
     * @param {Function} log logger function (default = console.log)
     */
    constructor(sqs, options, log = console.log) {
        this.sqs = sqs;
        this.options = options;
        this.log = log;
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
     * Connects to all required SQS queues by retrieving their URL
     */
    async _connectToQueues() {
        this.log(chalk`Connecting to SQS queue '{green ${this.options.queue}}' in the '{green ${this.options.region}}' region...`)
        this.options.sourceQueueUrl = (await this.sqs.getQueueUrl({
            QueueName: this.options.queue,
        }).promise()).QueueUrl;
        const queueAttributes = await this.sqs.getQueueAttributes({
            QueueUrl: this.options.sourceQueueUrl,
            AttributeNames: ['ApproximateNumberOfMessages']
        }).promise();
        this.log(chalk`This queue has approximately {green ${queueAttributes.Attributes.ApproximateNumberOfMessages}} messages at the moment.`);
        if (this.options.moveTo) {
            this.log(`Connecting to target SQS queue '{green ${this.options.moveTo}}' in the '{green ${this.options.region}}' region...`);
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
        if (options.moveTo || options.copyTo) {
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
}

module.exports = { SqsGrep };