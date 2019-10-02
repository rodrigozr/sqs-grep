const commandLineArgs = require('command-line-args');
const commandLineUsage = require('command-line-usage');
const chalk = require('chalk');
const {version} = require('./package.json');

/**
 * Parses a command-line "--attribute" argument into an attribute matching definition
 * @param {String} str the argument to parse
 * @returns {Object} {attr: attribute name, regexp: regular expression match}
 */
const parseAttribute = str => ({
    attr: str.substring(0, str.indexOf('=')),
    regexp: RegExp(str.substring(str.indexOf('=') + 1))
});

/**
 * All command-line option definitions
 */
const optionDefinitions = [
    // Main
    { name: 'queue', alias: 'q', description: '{bold (mandatory)} SQS Queue name', group: 'main' },
    { name: 'region', alias: 'r', defaultValue: 'us-east-1', description: 'AWS region name', group: 'main' },
    { name: 'body', alias: 'b', type: RegExp, group: 'main', description: 'Optional regular expression pattern to match the message body' },
    { name: 'attribute', alias: 'a', group: 'main', multiple: true, type: parseAttribute, typeLabel: '{underline attr}={underline regexp}', description: 'Matches a message attribute\nYou can set this option multiple times to match multiple attributes' },
    { name: 'delete', type: Boolean, group: 'main', description: 'Deletes matched messages from the queue (use with caution)' },
    { name: 'moveTo', typeLabel: '{underline queue name}', group: 'main', description: 'Moves matched messages to the given destination queue' },
    { name: 'all', type: Boolean, group: 'main', description: 'Matches all messages in the queue (do not filter anything). Setting this flag overrides {bold --body} and {bold --attribute}' },
    // Credentials
    { name: 'inputCredentials', alias: 'i', type: Boolean, description: 'Input the AWS access key id and secret access key via {underline stdin}', group: 'credentials' },
    { name: 'accessKeyId', description: 'AWS access key id ({bold not recommended:} use "aws configure" or "--inputCredentials" instead)', group: 'credentials' },
    { name: 'secretAccessKey', description: 'AWS secret access key ({bold not recommended:} use "aws configure" or "--inputCredentials" instead)', group: 'credentials' },
    // Other
    { name: 'negate', alias: 'n', type: Boolean, defaultValue: false, description: 'Negates the result of the pattern matching\n(I.e.: to find messages NOT containing a text)' },
    { name: 'timeout', alias: 't', type: Number, defaultValue: 60, typeLabel: '{underline seconds}', description: 'Timeout for the whole operation to complete.\nThe message visibility timeout will be calculated based on this value as well and the elapsed time to ensure that messages become visible again as soon as possible.' },
    { name: 'maxMessages', alias: 'm', type: parseInt, defaultValue: 0, typeLabel: '{underline integer}', description: 'Maximum number of messages to match' },
    { name: 'parallel', alias: 'j', type: Number, defaultValue: 1, description: 'Number of parallel pollers to start (to speed-up the scan)' },
    { name: 'silent', alias: 's', type: Boolean, defaultValue: false, description: 'Does not print the message contents (only count them)' },
    { name: 'full', alias: 'f', type: Boolean, defaultValue: false, description: 'Prints a JSON with the full message content (Body and all MessageAttributes)\nBy default, only the message body is printed' },
    { name: 'stripAttributes', type: Boolean, defaultValue: false, description: 'When {bold --moveTo} is set, this option will cause all message attributes to be stripped when moving it to the target queue' },
    { name: 'outputFile', alias: 'o', typeLabel: '{underline file}', description: 'Write matched messages to the given output file instead of the console. Combine with {bold --full} to have exact message reproduction, one per line in the output file' },
    { name: 'help', alias: 'h', type: Boolean, defaultValue: false, description: 'Prints this help message' },
    { name: 'version', alias: 'v', type: Boolean, defaultValue: false, description: 'Prints the application version' },
];

/**
 * Help text definition
 */
const usage = [
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
            + `$ ./sqs-grep --queue MyQueue --body Error\n`
            + `\n`
            + `{italic Find messages NOT containing any three-digit numbers in the body:}\n`
            + `$ ./sqs-grep --queue MyQueue --negate --body "\\\\\\\\d\\{3\\}"\n`
            + `\n`
            + `{italic Find messages containing a string attribute called 'Error' and that attribute does NOT contain any three-digit numbers in its value:}\n`
            + `$ ./sqs-grep --queue MyQueue --negate --attribute "Error=\\\\\\\\d\\{3\\}"\n`
            + `\n`
            + `{italic Move all messages from one queue to another}\n`
            + `$ ./sqs-grep --queue MyQueue --moveTo DestQueue --all\n`
            + `\n`
            + `{italic Delete all messages containing the text 'Error' in the body}\n`
            + `$ ./sqs-grep --queue MyQueue --delete --body Error\n`
    },
];

/**
 * All command-line options in a single object
 */
const options = commandLineArgs(optionDefinitions)._all;

/**
 * Prints the application version to the console
 */
function showVersion() {
    console.log(`sqs-grep version ${version}`);
}

/**
 * Prints the command-line help to the console
 */
function showHelp() {
    showVersion();
    console.log(commandLineUsage(usage));
}

/**
 * Validates that all command-line options are valid and we can proceed
 * with the program execution.
 * 
 * If the options are not valid, this will print the error and usage help
 * and will return false.
 * @returns {Boolean} true if we can proceed
 */
function validateOptions() {
    if (options.help) {
        showHelp();
        return false;
    }
    if (options.version) {
        showVersion();
        return false;
    }
    if (!options.queue) {
        console.log(chalk`{red ERROR: You must specify {bold --queue}}`);
        console.log(chalk`{italic (See all options by specifying {bold --help} in the command-line)}`)
        return false;
    }
    if (!options.all && !options.body && (!options.attribute || !options.attribute.length)) {
        console.log(chalk`{red ERROR: You must specify at least one of {bold --all}, {bold --body}, or {bold --attribute}}`);
        console.log(chalk`{italic (See all options by specifying {bold --help} in the command-line)}`)
        return false;
    }
    return true;
}

function printMatchingRules() {
    const containing = options.negate ? chalk.red('not containing') : 'containing';
    const match = options.moveTo ? chalk.green('move') : options.delete ? chalk.red('DELETE') : 'match';
    if (options.all) {
        console.log(chalk`Will ${match} {bold ALL} messages in the queue.`);
        return;
    }
    if (options.body) {
        console.log(chalk`Will ${match} messages ${containing} the RegExp {green ${options.body}} in its body.`);
    }
    if (options.attribute) {
        for (let attribute of options.attribute) {
            console.log(chalk`Will ${match} messages containing an attribute named '{green ${attribute.attr}}' with its value ${containing} the RegExp {green ${attribute.regexp}}.`);
        }
    }
}
module.exports = {
    options,
    showVersion,
    showHelp,
    validateOptions,
    printMatchingRules,
};