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
* Dump matched messages to file
* Move matched messages to another SQS queue
* Copy matched messages to another SQS queue
* Publish matched messages to an SNS topic
* Delete matched messages
* Parallel scan for higher throughput
* Cross-platform, with pre-built binaries for Linux, MacOS and Windows

# Usage examples
Find messages containing the text 'Error' in the body:
```
$ sqs-grep --queue MyQueue --body "Error"
```

Find messages NOT containing any three-digit numbers in the body:
```
$ sqs-grep --queue MyQueue --negate --body "\\d{3}"
```

Find messages containing a string attribute called 'Error' and that attribute does NOT contain any three-digit numbers in its value:     
```
$ sqs-grep --queue MyQueue --negate --attribute "Error=\\d{3}"
```

Move all messages from one queue to another
```
$ sqs-grep --queue MyQueue --moveTo DestQueue --all
```

Delete all messages containing the text 'Error' in the body
```
$ sqs-grep --queue MyQueue --delete --body Error
```

# Providing credentials
By default, sqs-grep will read credentials from the `$HOME/.aws/credentials` file, which can be configured using the AWS CLI (aws configure).

You also have the options below to provide credentials:

## Prompting for credentials
```
$ sqs-grep --inputCredentials <other options>
```

## Using an external credential provider
You can use an external credential provider tool as long as it outputs two separated lines
containing the AWS "access key id" and "secret access key" (in that order).
```
$ get-aws-credentials | sqs-grep --inputCredentials <other options>
```

## Providing credentials in the command-line (not recommended)
This option is simple, but not recommended as the credentials may be easily accessible by other processes
```
$ sqs-grep --accessKeyId "KEY" --secretAccessKey "SECRET" <other options>
```

# Options
```
$ sqs-grep --help

sqs-grep version 1.8.0

sqs-grep

  Command-line tool used to scan thru an AWS SQS queue and find messages        
  matching a certain criteria                                                   

Main options

  -q, --queue string            (mandatory) SQS Queue name                                                    
  -r, --region string           AWS region name                                                               
  -b, --body regexp             Optional regular expression pattern to match the message body                 
  -a, --attribute attr=regexp   Matches a message attribute                                                   
                                You can set this option multiple times to match multiple attributes           
  --delete                      Delete matched messages from the queue (use with caution)                     
  --moveTo queue name           Move matched messages to the given destination queue                          
  --copyTo queue name           Copy matched messages to the given destination queue                          
  --publishTo topic ARN         Publish matched messages to the given destination SNS topic                   
  --all                         Matches all messages in the queue (do not filter anything). Setting this flag 
                                overrides --body and --attribute                                              

Credential options

  -i, --inputCredentials     Input the AWS access key id and secret access key via stdin                   
  --accessKeyId string       AWS access key id (not recommended: use "aws configure" or                    
                             "--inputCredentials" instead)                                                 
  --secretAccessKey string   AWS secret access key (not recommended: use "aws configure" or                
                             "--inputCredentials" instead)                                                 

Other options

  -n, --negate                Negates the result of the pattern matching                                    
                              (I.e.: to find messages NOT containing a text)                                
  -t, --timeout seconds       Timeout for the whole operation to complete.                                  
                              The message visibility timeout will be calculated based on this value as well 
                              and the elapsed time to ensure that messages become visible again as soon as  
                              possible.                                                                     
  -m, --maxMessages integer   Maximum number of messages to match                                           
  -j, --parallel number       Number of parallel pollers to start (to speed-up the scan)                    
  -s, --silent                Does not print the message contents (only count them)                         
  -f, --full                  Prints a JSON with the full message content (Body and all MessageAttributes)  
                              By default, only the message body is printed                                  
  --stripAttributes           When --moveTo is set, this option will cause all message attributes to be     
                              stripped when moving it to the target queue                                   
  -o, --outputFile file       Write matched messages to the given output file instead of the console.       
                              Combine with --full to have exact message reproduction, one per line in the   
                              output file                                                                   
  --endpointUrl URL           Use a custom AWS endpoint URL                                                 
  -h, --help                  Prints this help message                                                      
  -v, --version               Prints the application version                                                

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

```
