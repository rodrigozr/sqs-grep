# AWS SQS grep
Command-line tool used to scan thru an AWS SQS queue and find messages matching a certain criteria.
It can also optionally delete the matching messages or move them to another SQS queue.

[Download pre-built binaries here](https://github.com/rodrigozr/sqs-grep/releases)

# Usage examples
Find messages containing the text 'Error' in the body:
```
$ ./sqs-grep --queue MyQueue --body "Error"
```

Find messages NOT containing any three-digit numbers in the body:
```
$ ./sqs-grep --queue MyQueue --negate --body "\\d{3}"
```

Find messages containing a string attribute called 'Error' and that attribute does NOT contain any three-digit numbers in its value:     
```
$ ./sqs-grep --queue MyQueue --negate --attribute "Error=\\d{3}"
```

Move all messages from one queue to another
```
$ ./sqs-grep --queue MyQueue --moveTo DestQueue --body ^
```

Delete all messages containing the text 'Error' in the body
```
$ ./sqs-grep --queue MyQueue --delete --body Error
```

# Providing credentials
By default, sqs-grep will read credentials from the "$HOME/.aws/credentials" file, which can be configured using the AWS CLI (aws configure).

You also have the options below to provide credentials:

## Prompting for credentials
```
$ ./sqs-grep --inputCredentials <other options>
```

## Using an external credential provider
You can use an external credential provider tool as long as it outputs two separated lines
containing the AWS "access key id" and "secret access key" (in that order).
```
$ get-aws-credentials | ./sqs-grep --inputCredentials <other options>
```

## Providing credentials in the command-line (not recommended)
This option is simple, but not recommended as the credentials may be easily accessible by other processes
```
$ ./sqs-grep --accessKeyId "KEY" --secretAccessKey "SECRET" <other options>
```

# Options
```
$ ./sqs-grep --help

sqs-grep version 1.2

sqs-grep

  Command-line tool used to scan thru an AWS SQS queue and find messages        
  matching a certain criteria                                                   

Main options

  -q, --queue string            (mandatory) SQS Queue name                                                    
  -r, --region string           AWS region name                                                               
  -b, --body regexp             Optional regular expression pattern to match the message body                 
  -a, --attribute attr=regexp   Matches a message attribute                                                   
                                You can set this option multiple times to match multiple attributes           
  --delete                      Deletes matched messages from the queue (use with caution)                    
  --moveTo queue name           Moves matched messages to the given destination queue                         

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
  -f, --full                  Prints the full message content (Body and all MessageAttributes)              
                              By default, only the message body is printed                                  
  --stripAttributes           When --moveTo is set, this option will cause all message attributes to be     
                              stripped when moving it to the target queue                                   
  -h, --help                  Prints this help message                                                      
  -v, --version               Prints the application version                                                

Usage examples

  Find messages containing the text 'Error' in the body:                        
  $ ./sqs-grep --queue MyQueue --body Error                                     
                                                                                
  Find messages NOT containing any three-digit numbers in the body:             
  $ ./sqs-grep --queue MyQueue --negate --body "\\d{3}"                         
                                                                                
  Find messages containing a string attribute called 'Error' and that attribute 
  does NOT contain any three-digit numbers in its value:                        
  $ ./sqs-grep --queue MyQueue --negate --attribute "Error=\\d{3}"              
                                                                                
  Move all messages from one queue to another                                   
  $ ./sqs-grep --queue MyQueue --moveTo DestQueue --body ^                      
                                                                                
  Delete all messages containing the text 'Error' in the body                   
  $ ./sqs-grep --queue MyQueue --delete --body Error                            
```
