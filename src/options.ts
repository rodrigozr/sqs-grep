import commandLineArgs from 'command-line-args';
import commandLineUsage from 'command-line-usage';
// Everything coloured here is a diagnostic, which goes to stderr: chalkStderr
// bases its colour support on stderr rather than stdout, so diagnostics stay
// coloured on the terminal even when stdout is piped somewhere else.
import {chalkStderr as chalk} from 'chalk';
import fs from 'fs';
import {dirname, join} from 'path';
import type {Logger, SqsClient, SnsClient} from './types.js';

/**
 * Reads the version of this package from the nearest `package.json`, walking up
 * from the given directory. The code may run from `src/` (development), `dist/`
 * (published) or a test build directory, which all sit at different depths,
 * hence the search.
 * @param startDir directory to start searching from (defaults to this file's directory)
 * @returns the package version
 * @internal
 */
export function readPackageVersion(startDir: string = import.meta.dirname): string {
    let dir = startDir;
    for (;;) {
        try {
            return (JSON.parse(fs.readFileSync(join(dir, 'package.json'), 'utf-8')) as {version: string}).version;
        } catch {
            const parent = dirname(dir);
            if (parent === dir) {
                throw new Error(`Could not find the sqs-grep package.json above '${startDir}'`);
            }
            dir = parent;
        }
    }
}

const version = readPackageVersion();

/**
 * A `--attribute` matching rule
 */
export interface AttributeMatcher {
    /** Name of the message attribute */
    attr: string;
    /** Regular expression the attribute value must match */
    regexp: RegExp;
}

/**
 * All sqs-grep options: the parsed command-line arguments, plus a few
 * programmatic extras (`sqs`, `sns`, `log`) and values resolved at runtime.
 */
export interface SqsGrepOptions {
    // Main
    queue?: string;
    region: string;
    body?: RegExp;
    all?: boolean;
    attribute?: AttributeMatcher[];
    delete?: boolean;
    moveTo?: string;
    copyTo?: string;
    publishTo?: string;
    republish?: boolean;
    redrive?: boolean;
    // Credentials
    inputCredentials?: boolean;
    accessKeyId?: string;
    secretAccessKey?: string;
    sessionToken?: string;
    // Other
    negate: boolean;
    timeout: number;
    maxMessages: number;
    parallel: number;
    silent: boolean;
    full: boolean;
    stripAttributes: boolean;
    outputFile?: string;
    inputFile?: string;
    stateFile?: string;
    stateFileInterval: number;
    scriptFile?: string;
    emptyReceives: number;
    wait: number;
    endpointUrl?: string;
    maxTPS: number;
    maxRetries: number;
    verbose: boolean;
    help: boolean;
    version: boolean;

    // Programmatic extras (not available from the command-line)
    /** Custom SQS client (defaults to the AWS SDK client) */
    sqs?: SqsClient;
    /** Custom SNS client (defaults to the AWS SDK client) */
    sns?: SnsClient;
    /** Diagnostics logger: progress, warnings and errors (defaults to `console.error`, i.e. stderr) */
    log?: Logger;
    /** Results writer: matched messages, `--help` and `--version` (defaults to `console.log`, i.e. stdout) */
    out?: Logger;

    // Resolved at runtime while connecting to the queues
    sourceQueueUrl?: string;
    moveToQueueUrl?: string;
    copyToQueueUrl?: string;
}

/**
 * Parses a command-line "--attribute" argument into an attribute matching definition
 * @param str the argument to parse
 * @returns {attr: attribute name, regexp: regular expression match}
 */
const parseAttribute = (str: string): AttributeMatcher => ({
    attr: str.substring(0, str.indexOf('=')),
    regexp: RegExp(str.substring(str.indexOf('=') + 1))
});

/**
 * All command-line option definitions
 */
const optionDefinitions: (commandLineUsage.OptionDefinition & commandLineArgs.OptionDefinition)[] = [
    // Main
    { name: 'queue', alias: 'q', description: 'Source SQS Queue name or URL', group: 'main' },
    { name: 'region', alias: 'r', defaultValue: 'us-east-1', description: 'AWS region name', group: 'main' },
    { name: 'body', alias: 'b', type: RegExp, group: 'main', description: 'Optional regular expression pattern to match the message body' },
    { name: 'all', type: Boolean, group: 'main', description: 'Matches all messages in the queue (do not filter anything). Setting this flag overrides {bold --body} and {bold --attribute}' },
    { name: 'attribute', alias: 'a', group: 'main', multiple: true, type: parseAttribute, typeLabel: '{underline attr}={underline regexp}', description: 'Matches a message attribute\nYou can set this option multiple times to match multiple attributes' },
    { name: 'delete', type: Boolean, group: 'main', description: 'Delete matched messages from the queue (use with caution)' },
    { name: 'moveTo', group: 'main', description: 'Move matched messages to the given destination queue name or URL' },
    { name: 'copyTo', group: 'main', description: 'Copy matched messages to the given destination queue name or URL' },
    { name: 'publishTo', typeLabel: '{underline topic ARN}', group: 'main', description: 'Publish matched messages to the given destination SNS topic' },
    { name: 'republish', type: Boolean, group: 'main', description: 'Republish messages that originated from SNS back to their topic of origin.\nThis option is typically used together with the {bold --delete} option to re-process "dead-letter queues" from an SNS topic.\nMessages which are not originated from SNS will be ignored.' },
    { name: 'redrive', type: Boolean, group: 'main', description: 'Move matched messages from a dead-letter queue (DLQ) back into its original queue, based on the RedrivePolicy configuration. Only works if the DLQ has a single source queue configured via RedrivePolicy. This has the same effect as setting {bold --moveTo}, but automatically detects the original queue to move messages to.' },
    // Credentials
    { name: 'inputCredentials', alias: 'i', type: Boolean, description: 'Input the AWS access key id and secret access key via {underline stdin}', group: 'credentials' },
    { name: 'accessKeyId', description: 'AWS access key id ({bold not recommended:} use "aws configure" or "--inputCredentials" instead)', group: 'credentials' },
    { name: 'secretAccessKey', description: 'AWS secret access key ({bold not recommended:} use "aws configure" or "--inputCredentials" instead)', group: 'credentials' },
    { name: 'sessionToken', description: 'AWS session token', group: 'credentials' },
    // Other
    { name: 'negate', alias: 'n', type: Boolean, defaultValue: false, description: 'Negates the result of the pattern matching\n(I.e.: to find messages NOT containing a text)' },
    { name: 'timeout', alias: 't', type: Number, defaultValue: 60, typeLabel: '{underline seconds}', description: 'Timeout for the whole operation to complete.\nThe message visibility timeout will be calculated based on this value as well and the elapsed time to ensure that messages become visible again as soon as possible.' },
    { name: 'maxMessages', alias: 'm', type: parseInt, defaultValue: 0, typeLabel: '{underline integer}', description: 'Maximum number of messages to match' },
    { name: 'parallel', alias: 'j', type: Number, defaultValue: 1, description: 'Number of parallel pollers to start (to speed-up the scan)' },
    { name: 'silent', alias: 's', type: Boolean, defaultValue: false, description: 'Does not print the message contents (only count them)' },
    { name: 'full', alias: 'f', type: Boolean, defaultValue: false, description: 'Prints a JSON with the full message content (Body and all MessageAttributes)\nBy default, only the message body is printed' },
    { name: 'stripAttributes', type: Boolean, defaultValue: false, description: 'This option will cause all message attributes to be stripped when moving, copying and publishing the message (used with {bold --moveTo}, {bold --copyTo}, {bold --publishTo}, and {bold --republish})' },
    { name: 'outputFile', alias: 'o', typeLabel: '{underline file}', description: 'Write matched messages to the given output file instead of the console. Using this option automatically sets {bold --full} to have exact message reproduction, which can be later used with {bold --inputFile}' },
    { name: 'inputFile', typeLabel: '{underline file}', description: 'Reads messages from a local file (generated using {bold --outputFile}) instead of from input queue' },
    { name: 'stateFile', typeLabel: '{underline file}', description: 'Saves the progress of an {bold --inputFile} scan into the given file, so that a future run using the same {bold --stateFile} resumes from the message right after the last one processed. Requires {bold --inputFile}' },
    { name: 'stateFileInterval', type: Number, defaultValue: 100, typeLabel: '{underline messages}', description: 'Number of processed messages between {bold --stateFile} saves (default: 100). The state is always saved at the end of the execution, including when it is interrupted' },
    { name: 'scriptFile', typeLabel: '{underline file.js}', description: 'Uses a custom user-script to process messages. See https://github.com/rodrigozr/sqs-grep/blob/master/user-scripts.md' },
    { name: 'emptyReceives', alias: 'e', type: Number, defaultValue: 5, description: 'Consider the queue fully scanned after this number of consecutive "empty receives" (default: 5)' },
    { name: 'wait', alias: 'w', type: Number, typeLabel: '{underline seconds}', defaultValue: 0, description: 'Number of seconds to wait after each "empty receive" (default: 0 - do not wait)' },
    { name: 'endpointUrl', typeLabel: '{underline URL}', description: 'Use a custom AWS endpoint URL' },
    { name: 'maxTPS', type: Number, defaultValue: 0, description: 'Maximum number of messages to process per second (default: no limit)' },
    { name: 'maxRetries', type: Number, defaultValue: 3, description: 'Maximum number of retries for failed API calls (default: 3)' },
    { name: 'verbose', type: Boolean, defaultValue: false, description: 'Enables verbose logging, which will also log all individual AWS API calls' },
    { name: 'help', alias: 'h', type: Boolean, defaultValue: false, description: 'Prints this help message' },
    { name: 'version', alias: 'v', type: Boolean, defaultValue: false, description: 'Prints the application version' },
];

/**
 * Help text definition
 */
const usage: commandLineUsage.Section[] = [
    {
        header: 'sqs-grep',
        content: 'Command-line tool used to scan thru an AWS SQS queue and find messages matching a certain criteria'
    },
    {
        header: 'Main options',
        optionList: optionDefinitions,
        group: 'main' },
    {
        header: 'Credential options',
        content: 'There are two ways to configure the AWS access credentials:\n'
            + '1. Using the AWS command-line tools ({bold aws configure}) - {green recommended}\n'
            + '2. Using the command-line options listed below - {red not recommended}\n',
        optionList: optionDefinitions,
        group: 'credentials'
    },
    { header: 'Other options', optionList: optionDefinitions, group: '_none' },
    {
        header: 'Usage examples',
        content: `{italic Find messages containing the text 'Error' in the body:}\n`
            + `$ sqs-grep --queue MyQueue --body Error\n`
            + `\n`
            + `{italic Find messages NOT containing any three-digit numbers in the body:}\n`
            + `$ sqs-grep --queue MyQueue --negate --body "\\\\\\\\d\\{3\\}"\n`
            + `\n`
            + `{italic Find messages containing a string attribute called 'Error' and that attribute does NOT contain any three-digit numbers in its value:}\n`
            + `$ sqs-grep --queue MyQueue --negate --attribute "Error=\\\\\\\\d\\{3\\}"\n`
            + `\n`
            + `{italic Move all messages from one queue to another}\n`
            + `$ sqs-grep --queue MyQueue --moveTo DestQueue --all\n`
            + `\n`
            + `{italic Delete all messages containing the text 'Error' in the body}\n`
            + `$ sqs-grep --queue MyQueue --delete --body Error\n`
            + `\n`
            + `{italic Archives all messages from a queue into a local file, and then later copy them to another queue}\n`
            + `$ sqs-grep --queue MyQueue --all --outputFile messages.txt\n`
            + `$ sqs-grep --inputFile messages.txt --all --copyTo TargetQueue\n`
            + `\n`
            + `{italic Copy messages from a local file to a queue, keeping track of the progress so that it can be safely resumed}\n`
            + `$ sqs-grep --inputFile messages.txt --all --copyTo TargetQueue --stateFile state.json\n`
    },
];

/**
 * Parses command-line arguments
 * @param argv optional arguments (defaults to the process arguments)
 * @returns parsed options
 */
export function parseOptions(argv?: string[]): SqsGrepOptions {
    const options = commandLineArgs(optionDefinitions, {argv})._all as SqsGrepOptions;
    return options;
}

/**
 * Prints the application version
 * @param out writer to use (stdout: the version was explicitly asked for)
 */
export function showVersion(out: Logger): void {
    out(`sqs-grep version ${version}`);
}

/**
 * Prints the command-line help
 * @param out writer to use (stdout: the help was explicitly asked for)
 */
export function showHelp(out: Logger): void {
    showVersion(out);
    out(commandLineUsage(usage));
}

/**
 * Validates that all command-line options are valid and we can proceed
 * with the program execution.
 *
 * If the options are not valid, this will print the error and usage help
 * and will return false.
 * @param options parsed options
 * @param log diagnostics logger, used for validation errors
 * @param out results writer, used for `--help` and `--version` (defaults to `log`)
 * @returns true if we can proceed
 */
export function validateOptions(options: SqsGrepOptions, log: Logger, out: Logger = log): boolean {
    if (options.help) {
        showHelp(out);
        return false;
    }
    if (options.version) {
        showVersion(out);
        return false;
    }
    const error = (msg: string): false => {
        log(msg);
        log(chalk.italic(`(See all options by specifying ${chalk.bold(`--help`)} in the command-line)`));
        return false;
    };
    if (!options.queue && !options.inputFile) {
        return error(chalk.red(`ERROR: You must specify ${chalk.bold(`--queue`)} or ${chalk.bold(`--inputFile`)}`));
    }
    if (options.queue && options.inputFile) {
        return error(chalk.red(`ERROR: You can't specify both ${chalk.bold(`--queue`)} and ${chalk.bold(`--inputFile`)} (choose one or the other)`));
    }
    if (!options.all && !options.body && (!options.attribute || !options.attribute.length)) {
        return error(chalk.red(`ERROR: You must specify at least one of ${chalk.bold(`--all`)}, ${chalk.bold(`--body`)}, or ${chalk.bold(`--attribute`)}`));
    }
    if (options.copyTo && options.delete) {
        return error(chalk.red(`ERROR: You can't specify both ${chalk.bold(`--copyTo`)} and ${chalk.bold(`--delete`)}! Use ${chalk.bold(`--moveTo`)} instead`));
    }
    if (options.moveTo && options.redrive) {
        return error(chalk.red(`ERROR: You can't specify both ${chalk.bold(`--moveTo`)} and ${chalk.bold(`--redrive`)}!`));
    }
    if (!(options.parallel > 0)) {
        return error(chalk.red(`ERROR: Invalid ${chalk.bold(`--parallel`)} value (must be greater than 0)`));
    }
    if (!(options.timeout > 0)) {
        return error(chalk.red(`ERROR: Invalid ${chalk.bold(`--timeout`)} value (must be greater than 0)`));
    }
    if (options.inputFile) {
        if (options.delete) {
            return error(chalk.red(`ERROR: You can't specify both ${chalk.bold(`--inputFile`)} and ${chalk.bold(`--delete`)}!`));
        }
        if (options.moveTo) {
            return error(chalk.red(`ERROR: You can't specify both ${chalk.bold(`--inputFile`)} and ${chalk.bold(`--moveTo`)}! Use ${chalk.bold(`--copyTo`)} instead`));
        }
    }
    if (options.stateFile && !options.inputFile) {
        return error(chalk.red(`ERROR: ${chalk.bold(`--stateFile`)} can only be used together with ${chalk.bold(`--inputFile`)}!`));
    }
    if (options.stateFile && !(options.stateFileInterval > 0)) {
        return error(chalk.red(`ERROR: Invalid ${chalk.bold(`--stateFileInterval`)} value (must be greater than 0)`));
    }
    if (options.outputFile) {
        options.full = true;
    }
    return true;
}

/**
 * Prints the matching rules for the given parsed options
 * @param options parsed options
 * @param log logger to use
 */
export function printMatchingRules(options: SqsGrepOptions, log: Logger): void {
    const containing = options.negate ? chalk.red('not containing') : 'containing';
    const match = (options.moveTo && options.copyTo) ? chalk.green('copy and move') :
        options.moveTo ? chalk.green('move') :
        options.copyTo ? chalk.green('copy') :
        options.delete ? chalk.red('DELETE') :
        'match';
    const queue = options.inputFile ? 'file' : 'queue';
    if (options.all) {
        log(`Will ${match} ${chalk.bold(`ALL`)} messages in the ${queue}.`);
        return;
    }
    if (options.body) {
        log(`Will ${match} messages ${containing} the RegExp ${chalk.green(options.body)} in its body.`);
    }
    if (options.attribute) {
        for (const attribute of options.attribute) {
            log(`Will ${match} messages containing an attribute named '${chalk.green(attribute.attr)}' with its value ${containing} the RegExp ${chalk.green(attribute.regexp)}.`);
        }
    }
}
