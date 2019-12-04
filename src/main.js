#! /usr/bin/env node

const process = require('process');
const prompt = require('password-prompt');
const {parseOptions} = require('./options');
const {SqsGrep} = require('./sqs-grep');

/**
 * Main processing loop
 */
async function main() {
    const options = parseOptions();
    await fillInputCredentials(options);
    const sqsGrep = new SqsGrep(options);
    // Graceful stop on interrupt signal (CTRL+C for example)
    process.on('SIGINT', () => {
        sqsGrep.log("Caught interrupt signal");
        sqsGrep.interrupt();
    });
    await sqsGrep.run();
}

/**
 * Fill input credentials into the options, if needed
 * @param {*} options sqs-grep options
 */
async function fillInputCredentials(options) {
    if (options.inputCredentials) {
        /* eslint-disable require-atomic-updates */
        options.accessKeyId = await prompt('AWS access key id:');
        options.secretAccessKey = await prompt('AWS secret access key:');
    }
}

// Execute the async main loop and print any errors if they arise
main().catch(err => {
    console.error(err.stack);
    process.exit(1);
});
