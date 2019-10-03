#! /usr/bin/env node

const prompt = require('password-prompt');
const AWS = require('aws-sdk');
const fs = require('fs');
const os = require('os');
const {parseOptions, validateOptions, printMatchingRules} = require('./options');

let sqs = new AWS.SQS();
const options = parseOptions();

/**
 * Main processing loop
 */
async function main() {
    sqs = new AWS.SQS(await getSqsOptions());
    console.log(`Connecting to SQS queue '${options.queue}' in the '${options.region}' region...`)
    const sourceQueueUrl = (await sqs.getQueueUrl({
        QueueName: options.queue,
    }).promise()).QueueUrl;
    const queueAttributes = await sqs.getQueueAttributes({
        QueueUrl: sourceQueueUrl,
        AttributeNames: ['ApproximateNumberOfMessages']
    }).promise();
    console.log(`This queue has approximately ${queueAttributes.Attributes.ApproximateNumberOfMessages} messages at the moment.`);
    let targetQueueUrl = null;
    if (options.moveTo) {
        console.log(`Connecting to target SQS queue '${options.moveTo}' in the '${options.region}' region...`);
        targetQueueUrl = (await sqs.getQueueUrl({
            QueueName: options.moveTo,
        }).promise()).QueueUrl;
    }
    const startedAt = new Date().getTime();
    const endAt = startedAt + options.timeout * 1000;
    let emptyReceives = 0;
    let running = true;
    let qtyScanned = 0;
    let qtyMatched = 0;
    // Graceful stop on interrupt signal (CTRL+C for example)
    process.on('SIGINT', () => {
        console.log("Caught interrupt signal");
        running = false;
    });
    printMatchingRules();
    const keepRunning = () => running && new Date().getTime() < endAt && (options.maxMessages == 0 || qtyMatched < options.maxMessages);
    console.log('Scanning...');
    const promises = nTimes(options.parallel, async () => {
        while (keepRunning()) {
            try {
                const elapsedSeconds = parseInt((new Date().getTime() - startedAt) / 1000);
                const res = await sqs.receiveMessage({
                    QueueUrl: sourceQueueUrl,
                    MaxNumberOfMessages: 10,
                    VisibilityTimeout: Math.max(1, options.timeout + 10 - elapsedSeconds),
                    MessageAttributeNames: ['All'],
                }).promise();
                if (!res.Messages || !res.Messages.length) {
                    if (++emptyReceives < 5) {
                        continue;
                    } else {
                        break;
                    }
                }
                qtyScanned += res.Messages.length;
                if (!keepRunning()) {
                    break;
                }
                // Process received messages
                for (let message of res.Messages) {
                    if (isMessageMatched(message)) {
                        qtyMatched++;
                        await processMatchedSqsMessage(message, sourceQueueUrl, targetQueueUrl);
                        if (!keepRunning()) {
                            break;
                        }
                    }
                }
            } catch (error) {
                running = false;
                throw error;
            }
        }
    });
    // Wait for all parallel executions to complete
    await Promise.all(promises);

    // Print the status
    console.log(`\nMessages scanned: ${qtyScanned}\nMessages matched: ${qtyMatched}`);
    if (!running) console.log('Interrupted');
    else if (options.maxMessages && qtyMatched >= options.maxMessages) console.log('Done - Maximum number of messages matched');
    else if (new Date().getTime() < endAt) console.log('Done - Scanned the whole queue');
    else console.log('Time exceeded');
}

/**
 * Checks if a message matches the options received
 * @param {Object} message SQS message
 * @returns {Boolean} true if it matches
 */
function isMessageMatched(message) {
    if (options.all) {
        return true;
    }
    if (options.body && negate(options.body.test(message.Body))) {
        return true;
    }
    // Check if message any attributes match
    if (options.attribute && message.MessageAttributes) {
        for (let attribute of options.attribute) {
            const messageAttribute = message.MessageAttributes[attribute.attr];
            if (messageAttribute && messageAttribute.StringValue && negate(attribute.regexp.test(messageAttribute.StringValue))) {
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
function printSqsMessage(message) {
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
        console.log(content);
    }
}

/**
 * Prints an SQS message to the console, based on the options
 * @param {Object} message SQS message
 * @param {String} sourceQueueUrl source SQS queue URL
 * @param {String} targetQueueUrl target SQS queue URL (when --moveTo is set)
 */
async function processMatchedSqsMessage(message, sourceQueueUrl, targetQueueUrl) {
    await printSqsMessage(message);
    if (options.moveTo) {
        if (!options.stripAttributes && message.MessageAttributes) {
            // Remove parameter values not supported yet
            for (let key in message.MessageAttributes) {
                delete message.MessageAttributes[key].StringListValues;
                delete message.MessageAttributes[key].BinaryListValues;
            }
        }
        // Copy the message to the target queue
        await sqs.sendMessage({
            QueueUrl: targetQueueUrl,
            MessageBody: message.Body,
            MessageAttributes: options.stripAttributes ? null : message.MessageAttributes,
        }).promise();
    }
    if (options.delete || options.moveTo) {
        // Delete the source message
        await sqs.deleteMessage({
            QueueUrl: sourceQueueUrl,
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
const negate = options.negate ? (b => !b) : (b => b)

/**
 * Executes a function a number of times and return an array with all the results
 * @param {Number} times number of times to run the function
 * @param {function} fn function to run
 * @returns {Array} array of results
 */
function nTimes(times, fn) {
    const res = [];
    for (let i = 0; i < times; i++) {
        res.push(fn());
    }
    return res;
}

/**
 * Retrieves AWS SQS SDK options
 * @returns {Object} the options based on command-line arguments
 */
async function getSqsOptions() {
    const opts = {
        region: options.region
    };
    if (options.accessKeyId) {
        opts.accessKeyId = options.accessKeyId;
    }
    if (options.secretAccessKey) {
        opts.secretAccessKey = options.secretAccessKey;
    }
    if (options.inputCredentials) {
        opts.accessKeyId = await prompt('AWS access key id:');
        opts.secretAccessKey = await prompt('AWS secret access key:');
    }
    return opts;
}

if (validateOptions()) {
    // Execute the async main loop and print any errors if they arise
    main().catch(err => {
        console.error(err.stack);
        process.exit(1);
    });
}
