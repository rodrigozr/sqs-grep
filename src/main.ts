#! /usr/bin/env node

import prompt from 'password-prompt';
import {parseOptions, type SqsGrepOptions} from './options.js';
import {SqsGrep} from './sqs-grep.js';

/**
 * Main processing loop
 */
async function main(): Promise<void> {
    const options = parseOptions();
    await fillInputCredentials(options);
    const sqsGrep = new SqsGrep(options);
    // Graceful stop on interrupt signal (CTRL+C for example)
    process.on('SIGINT', () => {
        sqsGrep.log("Caught interrupt signal");
        sqsGrep.interrupt();
    });
    // Graceful stop when whoever is reading our output goes away, as in
    // `sqs-grep ... | head -1`: the next write to stdout fails with EPIPE. Treat
    // it like an interrupt rather than an error, so that the scan stops instead
    // of carrying on into a closed pipe, and --stateFile still gets saved.
    process.stdout.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EPIPE') {
            sqsGrep.interrupt();
        } else {
            throw err;
        }
    });
    await sqsGrep.run();
}

/**
 * Fill input credentials into the options, if needed
 * @param options sqs-grep options
 */
async function fillInputCredentials(options: SqsGrepOptions): Promise<void> {
    if (options.inputCredentials) {
        // Note: assigning to 'options' after each await is intentional here, as the
        // prompts must be answered in order and nothing else runs concurrently
        options.accessKeyId = await prompt('AWS access key id:');
        options.secretAccessKey = await prompt('AWS secret access key:');
    }
}

// Execute the async main loop and print any errors if they arise
main().catch((err: Error) => {
    console.error(err.stack);
    process.exit(1);
});
