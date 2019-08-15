# AWS SQS grep
Command-line tool used to scan thru an AWS SQS queue and find messages matching a certain criteria

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

# Options
```
$ ./sqs-grep --help

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

Credential options (not recommended - use "aws configure" instead)

  --accessKeyId string       AWS access key id     
  --secretAccessKey string   AWS secret access key 

Other options

  -n, --negate            Negates the result of the pattern matching                                    
                          (I.e.: to find messages NOT containing a text)                                
  -t, --timeout seconds   Timeout for the whole operation to complete (also used as the SQS message     
                          visibility timeout)                                                           
  -j, --parallel number   Number of parallel pollers to start (to speed-up the scan)                    
  -s, --silent            Does not print the message contents (only count them)                         
  -f, --full              Prints the full message content (Body and all MessageAttributes)              
                          By default, only the message body is printed                                  
  --stripAttributes       When --moveTo is set, this option will cause all message attributes to be     
                          stripped when moving it to the target queue                                   
  -h, --help              Prints this help message                                                      

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