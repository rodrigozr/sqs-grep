#! /usr/bin/env node

const prompt = require('password-prompt');
const AWS = require('aws-sdk');
const {parseOptions} = require('./options');
const {SqsGrep} = require('./sqs-grep');

/**
 * Main processing loop
 */
async function main() {
    const options = parseOptions();
    const sqs = new AWS.SQS(await getSqsOptions(options));
    const sqsGrep = new SqsGrep(sqs, options);
    // Graceful stop on interrupt signal (CTRL+C for example)
    process.on('SIGINT', () => {
        sqsGrep.log("Caught interrupt signal");
        sqsGrep.interrupt();
    });
    await sqsGrep.run();
}

/**
 * Retrieves AWS SQS SDK options
 * @param {*} options sqs-grep options
 * @returns {Object} the SQS options based on command-line arguments
 */
async function getSqsOptions(options) {
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
    if (options.endpointUrl) {
        opts.endpoint = new AWS.Endpoint(options.endpointUrl);
    }
    return opts;
}

// Execute the async main loop and print any errors if they arise
main().catch(err => {
    console.error(err.stack);
    process.exit(1);
});
