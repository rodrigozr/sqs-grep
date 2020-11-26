# Using custom user-provided scripts with  AWS SQS grep 
`sqs-grep` supports custom message processing by providing a script file with the `--scriptFile` option.

Script files are **NodeJS modules**, written in JavaScript, and they will be directly loaded by sqs-grep.
This means that you should **NEVER** use scripts from unknown sources, since those scripts will have
full access to your computer.

# User script definition

```js
module.exports = {
    /**
     * Called right before an SQS message is read from the queue, and before any further processing is done.
     * The script is free to modify the message body and/or attributes, and those changes will be considered
     * by sqs-grep when further processing the message (such as determining wether it is a match or not, and
     * copying the message to other queues)
     * @param {*} message the raw SQS message
     * @see https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_Message.html
     */
    preProcessMessage(message) {
        // Do something with the message
        this.log(JSON.stringify(message));
    },
    /**
     * Called after an SQS message has been matched, and right before it is processed for further actions such
     * as moving and copying it.
     * The script is free to modify the message body and/or attributes, and those changes will be considered
     * by sqs-grep when further processing the message, such as when copying the message to other queues
     * @param {*} message the raw SQS message
     * @see https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_Message.html
     */
    preProcessMatchedMessage(message) {
        // Do something with the message
        this.log(JSON.stringify(message));
    }
};
```

All hooks will be bound to the `SqsGrep` instance which is currently running, so hooks have access to all objects exposed by SqsGrep, such as:
* `options` - object containing all execution options
* `log(message)` - function which logs something to the console, respecting the --silent command-line preference

# NodeJS `require()` support
User scripts are free to `require()` standard NodeJS modules normally.

User scripts can also call `sqs_grep_require()` to load custom modules included in sqs-grep
[package.json](https://github.com/rodrigozr/sqs-grep/blob/master/package.json), under the `dependencies` section.

# Sample use-case: Decode a GZipped Base64 body
Let's suppose the messages on your SQS queue are GZipped and then encoded in Base64, how can you find messages with a given body pattern?
You can use a custom script like this:

```js
const { Buffer } = require('buffer');
const { ungzip } = sqs_grep_require('node-gzip');

module.exports = {
    async preProcessMessage(message) {
        const body = await ungzip(Buffer.from(message.Body, 'base64'));
        message.Body = body.toString('utf-8');
    },
};
```

Then you can use it like this: `sqs-grep -q Queue --body Error --scriptFile script.js`

Now, imagine that you only want to decode the message for filtering them, but you still want to move the original message contents to another queue:

```js
const { Buffer } = require('buffer');
const { ungzip } = sqs_grep_require('node-gzip');

module.exports = {
    async preProcessMessage(message) {
        message.OriginalBody = Body;
        const body = await ungzip(Buffer.from(message.Body, 'base64'));
        message.Body = body.toString('utf-8');
    },
    preProcessMatchedMessage(message) {
        message.Body = message.OriginalBody;
        delete message.OriginalBody;
    },
};
```
Then you can use it like this: `sqs-grep -q Queue --body Error --moveTo OtherQueue --scriptFile script.js`
