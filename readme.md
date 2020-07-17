# AWS SQS grep 
[![npm version](https://badge.fury.io/js/sqs-grep.svg)](https://badge.fury.io/js/sqs-grep)
[![Build Status](https://travis-ci.org/rodrigozr/sqs-grep.svg?branch=master)](https://travis-ci.org/rodrigozr/sqs-grep)
[![Coverage Status](https://coveralls.io/repos/github/rodrigozr/sqs-grep/badge.svg?branch=master)](https://coveralls.io/github/rodrigozr/sqs-grep?branch=master)
[![Known Vulnerabilities](https://snyk.io/test/github/rodrigozr/sqs-grep/badge.svg)](https://snyk.io/test/github/rodrigozr/sqs-grep)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)

Powerful command-line tool used to scan thru an AWS SQS queue and find messages matching a certain criteria.
It can also delete the matching messages, copy/move them to another SQS queue and publish them to an SNS topic.

## Installation
* [Download pre-built binaries here](https://github.com/rodrigozr/sqs-grep/releases). The `sqs-grep` tool is distributed as a single executable, so feel free to extract it anywhere and use it from there.
* If you use NPM, you can also install it using the following command: `npm i -g sqs-grep`

## Features
* Find messages matching (or NOT matching) a regular expression
* Search by message attributes
* Silent mode if you just want to count the number of matched messages
* Dump matched messages to file, which can later be used for offline processing and archival
* Move/copy matched messages to another SQS queue
* Publish matched messages to an SNS topic (or re-publish to the original topic if the message originally came from SNS)
* Delete matched messages
* Parallel scan for higher throughput
* Cross-platform, with pre-built binaries for Linux, MacOS and Windows
* Supports FIFO queues for both sources and targets

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

The fact is that sqs-grep was designed to process arbitratly large SQS queues, and that would require
storing receipt handles in memory to then later make the messages visible again. For large queues, this
is simply not feasible, as we would need several GB of RAM just for that. Also, making the messages
visible again is a billed API call, and it would take some time to execute after the scan is completed,
which is also problematic for large queues.

# Options
```
$ sqs-grep --help

sqs-grep version 1.12.0

sqs-grep

  Command-line tool used to scan thru an AWS SQS queue and find messages        
  matching a certain criteria                                                   

Main options

  -q, --queue string            Source SQS Queue name or URL                                                  
  -r, --region string           AWS region name                                                               
  -b, --body regexp             Optional regular expression pattern to match the message body                 
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
  --all                         Matches all messages in the queue (do not filter anything). Setting this flag 
                                overrides --body and --attribute                                              

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
  -e, --emptyReceives number   Consider the queue fully scanned after this number of consecutive "empty      
                               receives" (default: 5)                                                        
  -w, --wait seconds           Number of seconds to wait after each "empty receive" (default: 0 - do not     
                               wait)                                                                         
  --endpointUrl URL            Use a custom AWS endpoint URL                                                 
  --maxTPS number              Maximum number of messages to process per second (default: no limit)          
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

```
