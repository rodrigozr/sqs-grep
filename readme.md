# AWS SQS grep 
[![npm version](https://badge.fury.io/js/sqs-grep.svg)](https://badge.fury.io/js/sqs-grep)
[![Build Status](https://github.com/rodrigozr/sqs-grep/actions/workflows/node.js.yml/badge.svg)](https://github.com/rodrigozr/sqs-grep/actions/workflows/node.js.yml)
[![Coverage Status](https://coveralls.io/repos/github/rodrigozr/sqs-grep/badge.svg?branch=master)](https://coveralls.io/github/rodrigozr/sqs-grep?branch=master)
[![Known Vulnerabilities](https://snyk.io/test/github/rodrigozr/sqs-grep/badge.svg)](https://snyk.io/test/github/rodrigozr/sqs-grep)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)

Powerful command-line tool used to scan thru an AWS SQS queue and find messages matching a certain criteria.
It can also delete the matching messages, copy/move them to another SQS queue and publish them to an SNS topic.

## Installation
Install it globally with NPM:
```sh
$ npm i -g sqs-grep
```

Or skip the installation entirely and run it straight from NPM with `npx`:
```sh
$ npx sqs-grep --queue MyQueue --body "Error"
```
`npx` downloads the latest version on first use and caches it, which makes it a convenient way to
run `sqs-grep` on a machine you would rather not install anything on (a bastion host or a CI job,
for example). Every example in this document works the same way with `npx sqs-grep` in place of
`sqs-grep`. To pin a specific version, pass it in the package name: `npx sqs-grep@2.0.0 --help`.

`sqs-grep` requires **Node.js 22.12 or later**.

### Running as a container
Official images are published to Docker Hub as
[rodrigozr/sqs-grep](https://hub.docker.com/r/rodrigozr/sqs-grep) for `linux/amd64` and
`linux/arm64`, so `sqs-grep` can run without a local Node.js installation:
```sh
$ docker run --rm rodrigozr/sqs-grep --help
```
Each release is tagged with its full version plus the moving `2.3`, `2` and `latest` tags, so pin
whichever you prefer: `rodrigozr/sqs-grep:2.0.0`, `rodrigozr/sqs-grep:2` and so on.

You can also build the image yourself from the `Dockerfile` in the repository (based on
`node:lts-alpine`) with Docker or any compatible tool such as Finch or Podman:
```sh
$ docker build -t sqs-grep .
```

The container runs as an unprivileged user with `/work` as its working directory. Mount the current
directory there to exchange files with it (`--inputFile`, `--outputFile`, `--stateFile` and
`--scriptFile` all resolve relative to it), and pass AWS credentials either as environment variables
or by mounting your AWS configuration read-only:
```sh
# Credentials from the environment
$ docker run --rm -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_SESSION_TOKEN \
    sqs-grep --queue MyQueue --region us-east-1 --body Error

# Credentials from ~/.aws, and files exchanged through the current directory
$ docker run --rm -v ~/.aws:/home/node/.aws:ro -e AWS_PROFILE -v "$PWD:/work" \
    sqs-grep --queue MyQueue --all --outputFile messages.txt
$ docker run --rm -v "$PWD:/work" \
    sqs-grep --inputFile messages.txt --all --scriptFile my-script.js
```
Add `-t` to get coloured output when running interactively.

> **Pre-compiled binaries are no longer distributed as of v1.19.** Earlier releases shipped
> single-executable builds for Linux, MacOS and Windows, produced with
> [pkg](https://github.com/vercel/pkg), which has since been deprecated. Binaries attached to
> releases up to v1.18.3 remain available on the
> [releases page](https://github.com/rodrigozr/sqs-grep/releases), but they will not receive any
> further updates. Please install from NPM instead, which is now the only supported distribution
> channel.

## Features
* Find messages matching (or NOT matching) a regular expression
* Search by message attributes
* Silent mode if you just want to count the number of matched messages
* Dump matched messages to file, which can later be used for offline processing and archival
* Resume an interrupted offline processing run exactly where it stopped (`--stateFile`)
* Move/copy matched messages to another SQS queue
* Publish matched messages to an SNS topic (or re-publish to the original topic if the message originally came from SNS)
* Delete matched messages
* Parallel scan for higher throughput
* Cross-platform: runs anywhere Node.js runs (Linux, MacOS and Windows)
* Supports FIFO queues for both sources and targets
* [Custom processing scripts](user-scripts.md)
* Written in TypeScript, and usable as a library from both JavaScript and TypeScript (see [Programmatic usage](#programmatic-usage))

# Usage examples
Find messages containing the text 'Error' in the body:
```sh
$ sqs-grep --queue MyQueue --body "Error"
```

Find messages NOT containing any three-digit numbers in the body:
```sh
$ sqs-grep --queue MyQueue --negate --body "\\d{3}"
```

Find messages containing a string attribute called 'Error' and that attribute does NOT contain any three-digit numbers in its value:     
```sh
$ sqs-grep --queue MyQueue --negate --attribute "Error=\\d{3}"
```

Move all messages from one queue to another
```sh
$ sqs-grep --queue MyQueue --moveTo DestQueue --all
```

Delete all messages containing the text 'Error' in the body
```sh
$ sqs-grep --queue MyQueue --delete --body Error
```

Archives all messages from a queue into a local file, and then later copy them to another queue
```sh
$ sqs-grep --queue MyQueue --all --outputFile messages.txt
$ sqs-grep --inputFile messages.txt --all --copyTo TargetQueue
```

Copy messages from a local file to a queue, keeping track of the progress so that it can be safely resumed
```sh
$ sqs-grep --inputFile messages.txt --all --copyTo TargetQueue --stateFile state.json
```

Pipe matched messages into other tools. Only the matched messages are written to `stdout` - all
progress and diagnostic output goes to `stderr` - so the output is safe to pipe or redirect:
```sh
$ sqs-grep --queue MyQueue --body '"status":"failed"' | jq .orderId
$ sqs-grep --queue MyQueue --all --full > messages.jsonl
```

# Resuming an interrupted offline run
When processing messages from a local file (`--inputFile`), you can pass `--stateFile <file>` to keep
track of how far the processing went. The state file records the index of the last message which was
fully processed, so that a future run using the same `--inputFile` and `--stateFile` skips everything
that was already done and resumes from the next message.

```sh
# First run - interrupted with CTRL+C after 10 messages
$ sqs-grep --inputFile queue.jsonl --all --copyTo TargetQueue --stateFile state.json
Caught interrupt signal
Progress saved to 'state.json' (last processed message: 10).

# Second run - resumes from message 11
$ sqs-grep --inputFile queue.jsonl --all --copyTo TargetQueue --stateFile state.json
Resuming from message 11 - skipping the first 10 message(s) already processed...
```

A few things worth knowing:
* `--stateFile` requires `--inputFile` (there is no stable message ordering to resume from in an SQS queue).
* To avoid writing to disk on every single message, the state is only saved every 100 processed messages
  (configurable with `--stateFileInterval`), plus once at the end of the execution - including when the
  execution is interrupted or fails. This means that a resumed run may re-process a few messages which
  were already handled, so processing is "at-least-once" rather than "exactly-once".
* Both matched and unmatched messages count as processed, so a resumed run never re-scans messages which
  were already filtered out.
* Only a contiguous run of processed messages is ever recorded, so a message which was still in-flight when
  the execution stopped is never skipped - even when using `--parallel`.
* The state file records which input file it belongs to. If it refers to a different file, is corrupt, or
  does not exist, it is ignored with a warning and the processing starts from the first message.
* Deleting the state file (or pointing `--stateFile` at a new path) restarts the processing from the beginning.

# Providing credentials
By default, sqs-grep will read credentials from:
* The [AWS shared credentials file](https://docs.aws.amazon.com/sdk-for-javascript/v2/developer-guide/loading-node-credentials-shared.html) `$HOME/.aws/credentials` file, which can be configured using the AWS CLI (`aws configure`).
* The [AWS credentials environment variable](https://docs.aws.amazon.com/sdk-for-javascript/v2/developer-guide/loading-node-credentials-environment.html) (`AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`).

However, you also have the options below to provide credentials:

## Prompting for credentials
```sh
$ sqs-grep --inputCredentials <other options>
AWS access key id:**************
AWS secret access key:****************************
```

## Using an external credential provider
You can use an external credential provider tool as long as it outputs two separated lines
containing the AWS "access key id" and "secret access key" (in that order).
```sh
$ get-aws-credentials | sqs-grep --inputCredentials <other options>
```

## Providing credentials in the command-line (not recommended)
This option is simple, but not recommended as the credentials may be easily accessible by other processes
```sh
$ sqs-grep --accessKeyId "KEY" --secretAccessKey "SECRET" <other options>
```

# Providing queue names or URLs
The options `--queue`, `--moveTo`, and `--copyTo` all support either a **queue name** or a **queue URL**.

If you provide a **queue name**, the URL will be automatically determined by connecting to the given AWS `--region`.
Using **queue URLs** allows you to copy or move messages between regions and even accounts
(as long as your credentials allow it).

In case you need to copy or move messages between accounts using different access credentials
(one for the source and another for the target), you still do it in two separate steps using the
`--outputFile` option (first download all the messages to a local file and then copy them to the
target account). 

# Operation timeout and SQS visibility timeouts
In order to scan through the SQS queue, `sqs-grep` must set an appropriate "message visibility timeout"
when receiving the messages (otherwise, the messages would become visible again in the queue before we
finished scanning the queue).

The way that sqs-grep does that is that it will automatically determine a "safe" visibility timeout for
each individual receive operation based on the `--timeout` option (which defaults to **1 minute**). This
ensures that messages will remain "in-flight" for the shortest possible timeframe that is safe. For
example, if you use the default timeout of 1 minute and your scan completes in 40 seconds, you can expect
all scanned messages to become visible again in approximately 20 seconds after the scan is completed.

Notice that, if the execution does not finish within the `--timeout`, sqs-grep will immediately stop the
processing with a proper warning message.

## Why doesn't sqs-grep immediatelly makes the messages visible again after completing the execution?
Good question! The AWS SQS console does that, for example, so why don't we do the same?

The fact is that sqs-grep was designed to process arbitrarily large SQS queues, and that would require
storing receipt handles in memory to then later make the messages visible again. For large queues, this
is simply not feasible, as we would need several GB of RAM just for that. Also, making the messages
visible again is a billed API call, and it would take some time to execute after the scan is completed,
which is also problematic for large queues.

# Limitations

All standard [SQS Quotas](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/quotas-queues.html) apply to any SQS client, including `sqs-grep`. The most important quota you should be aware of is the `"Messages per queue (in flight)"` limit of 120,000 messages for standard queues and 20,000 messages for FIFO queues.

This means that, when scanning for messages without moving or deleting them, you can easily reach this quota on large queues, and the scanning will stop after the quota is reached.

If you really need to scan more messages than the allowed "in-flight quota", you will need to use `--moveTo` to move the messages to a temporary queue, and then move them back to the original queue after you complete your search. You can also simply delete messages with the `--delete` flag if that is an option for you.

If you don't specify `--moveTo` nor `--delete`, and your source queue is larger than the allowed quota, sqs-grep will stop scanning once it reaches the SQS limit.

# Options
```
$ sqs-grep --help

sqs-grep version 2.0.0

sqs-grep

  Command-line tool used to scan thru an AWS SQS queue and find messages        
  matching a certain criteria                                                   

Main options

  -q, --queue string            Source SQS Queue name or URL                                                  
  -r, --region string           AWS region name                                                               
  -b, --body regexp             Optional regular expression pattern to match the message body                 
  --all                         Matches all messages in the queue (do not filter anything). Setting this flag 
                                overrides --body and --attribute                                              
  -a, --attribute attr=regexp   Matches a message attribute                                                   
                                You can set this option multiple times to match multiple attributes           
  --delete                      Delete matched messages from the queue (use with caution)                     
  --moveTo string               Move matched messages to the given destination queue name or URL              
  --copyTo string               Copy matched messages to the given destination queue name or URL              
  --publishTo topic ARN         Publish matched messages to the given destination SNS topic                   
  --republish                   Republish messages that originated from SNS back to their topic of origin.    
                                This option is typically used together with the --delete option to re-process 
                                "dead-letter queues" from an SNS topic.                                       
                                Messages which are not originated from SNS will be ignored.                   
  --redrive                     Move matched messages from a dead-letter queue (DLQ) back into its original   
                                queue, based on the RedrivePolicy configuration. Only works if the DLQ has a  
                                single source queue configured via RedrivePolicy. This has the same effect as 
                                setting --moveTo, but automatically detects the original queue to move        
                                messages to.                                                                  

Credential options

  -i, --inputCredentials     Input the AWS access key id and secret access key via stdin                   
  --accessKeyId string       AWS access key id (not recommended: use "aws configure" or                    
                             "--inputCredentials" instead)                                                 
  --secretAccessKey string   AWS secret access key (not recommended: use "aws configure" or                
                             "--inputCredentials" instead)                                                 

Other options

  -n, --negate                 Negates the result of the pattern matching                                    
                               (I.e.: to find messages NOT containing a text)                                
  -t, --timeout seconds        Timeout for the whole operation to complete.                                  
                               The message visibility timeout will be calculated based on this value as well 
                               and the elapsed time to ensure that messages become visible again as soon as  
                               possible.                                                                     
  -m, --maxMessages integer    Maximum number of messages to match                                           
  -j, --parallel number        Number of parallel pollers to start (to speed-up the scan)                    
  -s, --silent                 Does not print the message contents (only count them)                         
  -f, --full                   Prints a JSON with the full message content (Body and all MessageAttributes)  
                               By default, only the message body is printed                                  
  --stripAttributes            This option will cause all message attributes to be stripped when moving,     
                               copying and publishing the message (used with --moveTo, --copyTo,             
                               --publishTo, and --republish)                                                 
  -o, --outputFile file        Write matched messages to the given output file instead of the console. Using 
                               this option automatically sets --full to have exact message reproduction,     
                               which can be later used with --inputFile                                      
  --inputFile file             Reads messages from a local file (generated using --outputFile) instead of    
                               from input queue                                                             
  --stateFile file             Saves the progress of an --inputFile scan into the given file, so that a      
                               future run using the same --stateFile resumes from the message right after    
                               the last one processed. Requires --inputFile                                 
  --stateFileInterval messages Number of processed messages between --stateFile saves (default: 100). The    
                               state is always saved at the end of the execution, including when it is       
                               interrupted                                                                   
  --scriptFile file.js         Uses a custom user-script to process messages. See                            
                               https://github.com/rodrigozr/sqs-grep/blob/master/user-scripts.md             
  -e, --emptyReceives number   Consider the queue fully scanned after this number of consecutive "empty      
                               receives" (default: 5)                                                        
  -w, --wait seconds           Number of seconds to wait after each "empty receive" (default: 0 - do not     
                               wait)                                                                         
  --endpointUrl URL            Use a custom AWS endpoint URL                                                 
  --maxTPS number              Maximum number of messages to process per second (default: no limit)          
  --maxRetries number          Maximum number of retries for failed API calls (default: 3)                   
  --verbose                    Enables verbose logging, which will also log all individual AWS API calls     
  -h, --help                   Prints this help message                                                      
  -v, --version                Prints the application version                                                

Usage examples

  Find messages containing the text 'Error' in the body:                        
  $ sqs-grep --queue MyQueue --body Error                                       
                                                                                
  Find messages NOT containing any three-digit numbers in the body:             
  $ sqs-grep --queue MyQueue --negate --body "\\d{3}"                           
                                                                                
  Find messages containing a string attribute called 'Error' and that attribute 
  does NOT contain any three-digit numbers in its value:                        
  $ sqs-grep --queue MyQueue --negate --attribute "Error=\\d{3}"                
                                                                                
  Move all messages from one queue to another                                   
  $ sqs-grep --queue MyQueue --moveTo DestQueue --all                           
                                                                                
  Delete all messages containing the text 'Error' in the body                   
  $ sqs-grep --queue MyQueue --delete --body Error                              
                                                                                
  Archives all messages from a queue into a local file, and then later copy     
  them to another queue                                                         
  $ sqs-grep --queue MyQueue --all --outputFile messages.txt                    
  $ sqs-grep --inputFile messages.txt --all --copyTo TargetQueue                
                                                                                
  Copy messages from a local file to a queue, keeping track of the progress so   
  that it can be safely resumed                                                 
  $ sqs-grep --inputFile messages.txt --all --copyTo TargetQueue --stateFile     
  state.json                                                                    

```

# Custom script files
`sqs-grep` supports custom message processing by providing a script file with the `--scriptFile` option.

See [user-scripts.md](user-scripts.md) for additional documentation on that feature.

# Programmatic usage
Besides the command-line, `sqs-grep` can be used as a library. It is published as an ES module with
bundled TypeScript declarations, so it works the same from JavaScript and TypeScript:

```js
import { SqsGrep } from 'sqs-grep';

const sqsGrep = new SqsGrep({
    queue: 'MyQueue',
    region: 'us-east-1',
    body: /Error/,
    log: message => console.error(message), // optional - diagnostics, defaults to console.error (stderr)
    out: message => results.push(message),  // optional - matched messages, defaults to console.log (stdout)
});
const result = await sqsGrep.run();          // null when the options are invalid
console.log(result.qtyScanned, result.qtyMatched);
```

```ts
import { SqsGrep, type SqsGrepOptions } from 'sqs-grep';

const options: Partial<SqsGrepOptions> = { queue: 'MyQueue', all: true, copyTo: 'OtherQueue' };
const result = await new SqsGrep(options).run();
```

All command-line options are available as properties of the options object (`--maxMessages 10`
becomes `maxMessages: 10`, and so on). You can also inject your own AWS SDK clients with the `sqs`
and `sns` options, and call `interrupt()` to stop a running scan gracefully.

CommonJS code can still load the package on Node.js 22.12 or later, which supports `require()` of
ES modules natively: `const { SqsGrep } = require('sqs-grep');` keeps working unchanged.

# Upgrading from 1.x to 2.0
Version 2.0 is a rewrite of the code base in TypeScript. The command-line interface, the message
file format, and the user-script contract are unchanged, so existing scripts and workflows keep
working. The changes to be aware of are:
* **Node.js 22.12 or later is required** (Node.js 18 and 20 reached their end of life).
* **The package is now an ES module.** `import { SqsGrep } from 'sqs-grep'` is the primary way to use
  it as a library. `require('sqs-grep')` still works on Node.js 22.12+, which can `require()` ES modules
  natively, so most CommonJS consumers need no change - only older Node.js versions are affected.
* **User scripts are unaffected.** Existing plain JavaScript `--scriptFile` scripts using
  `module.exports` keep working as-is (see [user-scripts.md](user-scripts.md)), and scripts may now
  also be written as ES modules.
* **Diagnostics go to `stderr`, matched messages to `stdout`.** Progress, warnings, the final summary
  and `--verbose` API logs are now written to `stderr`, while `stdout` receives nothing but the matched
  messages (and `--help`/`--version` when requested). This makes `sqs-grep ... | jq` and
  `sqs-grep ... > file` work without any filtering. When a pipe is closed early (`sqs-grep ... | head`),
  the scan stops gracefully, like on CTRL+C. Library users who relied on the default logger being
  `console.log` should pass `log`/`out` explicitly: `log` (diagnostics) now defaults to `console.error`,
  and the new `out` option (results) defaults to `console.log`.
* **`--verbose` logs API calls through the SDK's structured logger** (`info`/`warn`/`error`), which is
  more detailed than before.
* For library users, the package entry point now exports TypeScript types alongside `SqsGrep`, and the
  main class lives in `dist/` instead of `src/` (only relevant if you deep-imported `sqs-grep/src/...`,
  which was never a supported path).
