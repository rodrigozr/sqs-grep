/* eslint-disable no-undef */
const AWS = require('aws-sdk');
const util = require('util');
const exec = util.promisify(require('child_process').exec);
const assert = require('assert');
const sinon = require('sinon');
const {parseOptions} = require('../src/options');
const {SqsGrep} = require('../src/sqs-grep');

const emptyLog = sinon.stub();

describe('Integration Tests', function () {
    let sqs = new AWS.SQS();
    let sns = new AWS.SNS();
    before(async function() {
        if (!process.env['RUN_INTEGRATION_TESTS']) {
            console.log('    Skipping integration tests because RUN_INTEGRATION_TESTS was not defined');
            this.skip();
            return;
        }
        this.timeout(6 * 60 * 1000);
        const containerName = 'localstack-sqs-grep-tests';
        try {
            // Check if docker is installed and working
            await exec('docker --version');
            console.log('    Starting docker container...');
            try {
                await exec(`docker rm -f ${containerName}`);
            } catch (err) {
                /* ignore */
            }
            // Start the docker container
            await exec(`docker run -d --name ${containerName} -p 4575-4576:4575-4576 -e SERVICES=sqs,sns localstack/localstack`);
            // Create a custom SQS connector
            let options = parseOptions(['--endpointUrl', 'http://localhost:4576']);
            sqs = new AWS.SQS({
                region: options.region,
                accessKeyId: 'FAKE',
                secretAccessKey: 'FAKE',
                endpoint:new AWS.Endpoint(options.endpointUrl)
            });
            // Create a custom SNS connector
            options = parseOptions(['--endpointUrl', 'http://localhost:4575']);
            sns = new AWS.SNS({
                region: options.region,
                accessKeyId: 'FAKE',
                secretAccessKey: 'FAKE',
                endpoint:new AWS.Endpoint(options.endpointUrl)
            });
            // Wait for it to be ready for a maximum of 5 minutes
            const deadline = new Date().getTime() + (5 * 60 * 1000);
            while (new Date().getTime() < deadline) {
                let {stdout} = await exec(`docker logs ${containerName}`);
                if (stdout.split('\n').includes('Ready.')) {
                    // Ensure we can create a queue and list SNS topics
                    try {
                        await sqs.createQueue({QueueName: 'ReadyTest'}).promise();
                        await sns.listTopics({}).promise();
                        // Success - the container is ready to be used!
                        return;
                    } catch (ex) {
                        console.log(ex);
                    }
                }
                // Wait 100ms...
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            throw new Error('Could not start the docker container');
        } catch (err) {
            console.log('    Skipping integration tests because docker is not installed or not working properly');
            this.skip();
        }
    });
    after(async function() {
        this.timeout(20000);
        try {
            console.log('    Removing docker container...');
            await exec(`docker rm -f ${containerName}`);
        } catch (err) {
            /* ignore */
        }
    });
    let queueUrl1, queueUrl2, queueUrl3;
    beforeEach(async function() {
        queueUrl1 = (await sqs.createQueue({QueueName: 'Queue1'}).promise()).QueueUrl;
        queueUrl2 = (await sqs.createQueue({QueueName: 'Queue2'}).promise()).QueueUrl;
        queueUrl3 = (await sqs.createQueue({QueueName: 'Queue3'}).promise()).QueueUrl;

        await sqs.sendMessage({QueueUrl: queueUrl1, MessageBody: 'message 1'}).promise();
        await sqs.sendMessage({QueueUrl: queueUrl1, MessageBody: 'message 2 - test'}).promise();
        await sqs.sendMessage({QueueUrl: queueUrl1, MessageBody: 'message 3'}).promise();
        await sqs.sendMessage({QueueUrl: queueUrl1, MessageBody: 'message 4 - test'}).promise();
    });
    afterEach(async function() {
        const queues = (await sqs.listQueues().promise()).QueueUrls;
        for (const url of queues) {
            await sqs.deleteQueue({QueueUrl: url}).promise();
        }
    });
    const getQueueAttribute = async (queueUrl, attribute) => {
        const queueAttributes = await sqs.getQueueAttributes({
            QueueUrl: queueUrl,
            AttributeNames: [attribute]
        }).promise();
        return queueAttributes.Attributes[attribute];
    };
    const parse = args => ({
        sqs, sns,
        log: emptyLog,
        ...parseOptions(args)
    });
    it('should scan the queue', async function () {
        // act
        const {qtyScanned, qtyMatched} = await new SqsGrep(parse(['--queue=Queue1', '--body=test'])).run();
        
        // assert
        assert.equal(qtyScanned, 4);
        assert.equal(qtyMatched, 2);
    });
    it('should copy the queue', async function () {
        // act
        const {qtyScanned, qtyMatched} = await new SqsGrep(parse(['--queue=Queue1', '--copyTo=Queue2', '--body=test'])).run();
        
        // assert
        assert.equal(qtyScanned, 4);
        assert.equal(qtyMatched, 2);
        assert.equal(await getQueueAttribute(queueUrl2, 'ApproximateNumberOfMessages'), 2);
        assert.equal(await getQueueAttribute(queueUrl1, 'ApproximateNumberOfMessagesNotVisible'), 4);
    });
    it('should publish the queue', async function () {
        // arrange
        const topic = (await sns.createTopic({Name: 'MyTopic'}).promise()).TopicArn;
        const queueArn = await getQueueAttribute(queueUrl2, 'QueueArn');
        await sns.subscribe({
            Protocol: 'sqs',
            TopicArn: topic,
            Endpoint: queueArn,
        }).promise();
        
        // act
        const {qtyScanned, qtyMatched} = await new SqsGrep(parse(['--queue=Queue1', '--publishTo', topic, '--body=test'])).run();
        
        // assert
        assert.equal(qtyScanned, 4);
        assert.equal(qtyMatched, 2);
        assert.equal(await getQueueAttribute(queueUrl2, 'ApproximateNumberOfMessages'), 2);
        assert.equal(await getQueueAttribute(queueUrl1, 'ApproximateNumberOfMessagesNotVisible'), 4);
    });
    it('should re-publish messages to the original queue', async function () {
        // arrange
        const topic = (await sns.createTopic({Name: 'MyTopicForRepublish'}).promise()).TopicArn;
        const queueArn = await getQueueAttribute(queueUrl2, 'QueueArn');
        await sns.subscribe({
            Protocol: 'sqs',
            TopicArn: topic,
            Endpoint: queueArn,
        }).promise();
        await sns.publish({
            TopicArn: topic,
            Message: "test publish",
        }).promise();
        await new SqsGrep(parse(['--queue=Queue2', '--moveTo=Queue3', '--body=publish'])).run();
        
        // act
        const {qtyScanned, qtyMatched} = await new SqsGrep(parse(['--queue=Queue3', '--delete', '--republish', '--body=publish'])).run();
        
        // assert
        assert.equal(qtyScanned, 1);
        assert.equal(qtyMatched, 1);
        assert.equal(await getQueueAttribute(queueUrl2, 'ApproximateNumberOfMessages'), 1);
        assert.equal(await getQueueAttribute(queueUrl3, 'ApproximateNumberOfMessages'), 0);
        assert.equal(await getQueueAttribute(queueUrl3, 'ApproximateNumberOfMessagesNotVisible'), 0);
    });
    it('should move the queue', async function () {
        // act
        const {qtyScanned, qtyMatched} = await new SqsGrep(parse(['--queue=Queue1', '--moveTo=Queue2', '--body=test'])).run();
        
        // assert
        assert.equal(qtyScanned, 4);
        assert.equal(qtyMatched, 2);
        assert.equal(await getQueueAttribute(queueUrl2, 'ApproximateNumberOfMessages'), 2);
        assert.equal(await getQueueAttribute(queueUrl1, 'ApproximateNumberOfMessages'), 0);
        assert.equal(await getQueueAttribute(queueUrl1, 'ApproximateNumberOfMessagesNotVisible'), 2);
    });
    it('should move and copy the queue', async function () {
        // act
        const {qtyScanned, qtyMatched} = await new SqsGrep(parse(['--queue=Queue1', '--moveTo=Queue2', '--copyTo=Queue3', '--body=test'])).run();
        
        // assert
        assert.equal(qtyScanned, 4);
        assert.equal(qtyMatched, 2);
        assert.equal(await getQueueAttribute(queueUrl2, 'ApproximateNumberOfMessages'), 2);
        assert.equal(await getQueueAttribute(queueUrl3, 'ApproximateNumberOfMessages'), 2);
        assert.equal(await getQueueAttribute(queueUrl1, 'ApproximateNumberOfMessages'), 0);
        assert.equal(await getQueueAttribute(queueUrl1, 'ApproximateNumberOfMessagesNotVisible'), 2);
    });
    it('should process from FIFO queue', async function () {
        // arrange
        const attr = {'FifoQueue': 'true', 'ContentBasedDeduplication':'true'};
        const fifoQueueUrl = (await sqs.createQueue({QueueName: 'Queue.fifo', Attributes: attr}).promise()).QueueUrl;
        await sqs.sendMessage({QueueUrl: fifoQueueUrl, MessageGroupId: '1', MessageBody: 'message 1'}).promise();
        await sqs.sendMessage({QueueUrl: fifoQueueUrl, MessageGroupId: '1', MessageBody: 'message 2 - test'}).promise();

        // act
        const {qtyScanned, qtyMatched} = await new SqsGrep(parse(['--queue=Queue.fifo', '--moveTo=Queue2', '--copyTo=Queue3', '--body=test'])).run();
        
        // assert
        assert.equal(qtyScanned, 2);
        assert.equal(qtyMatched, 1);
        assert.equal(await getQueueAttribute(queueUrl2, 'ApproximateNumberOfMessages'), 1);
        assert.equal(await getQueueAttribute(queueUrl3, 'ApproximateNumberOfMessages'), 1);
        assert.equal(await getQueueAttribute(fifoQueueUrl, 'ApproximateNumberOfMessages'), 0);
        assert.equal(await getQueueAttribute(fifoQueueUrl, 'ApproximateNumberOfMessagesNotVisible'), 1);
    });
    it('should process to FIFO queue', async function () {
        // arrange
        const attr = {'FifoQueue': 'true', 'ContentBasedDeduplication':'true'};
        const fifoQueueUrl = (await sqs.createQueue({QueueName: 'Queue.fifo', Attributes: attr}).promise()).QueueUrl;

        // act
        const {qtyScanned, qtyMatched} = await new SqsGrep(parse(['--queue=Queue1', '--copyTo=Queue.fifo', '--body=test'])).run();
        
        // assert
        assert.equal(qtyScanned, 4);
        assert.equal(qtyMatched, 2);
        assert.equal(await getQueueAttribute(fifoQueueUrl, 'ApproximateNumberOfMessages'), 2);
    });

});
