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
            } catch {}
            // Start the docker container
            await exec(`docker run -d --rm --name ${containerName} -p 4576:4576 -e SERVICES=sqs localstack/localstack`);
            // Create a custom SQS connector
            const options = parseOptions(['--endpointUrl', 'http://localhost:4576']);
            sqs = new AWS.SQS({
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
                    return;
                }
            }
            throw new Error('Could not start the docker container');
        } catch {
            console.log('    Skipping integration tests because docker is not installed or not working properly');
            this.skip();
        }
    });
    after(async function() {
        this.timeout(20000);
        try {
            console.log('    Removing docker container...');
            await exec(`docker rm -f ${containerName}`);
        } catch {}
    });
    let queueUrl1, queueUrl2, queueUrl3;
    beforeEach(async function() {
        queueUrl1 = (await sqs.createQueue({QueueName: 'Queue1'}).promise()).QueueUrl;
        queueUrl2 = (await sqs.createQueue({QueueName: 'Queue2'}).promise()).QueueUrl;
        queueUrl3 = (await sqs.createQueue({QueueName: 'Queue3'}).promise()).QueueUrl;

        await sqs.sendMessage({QueueUrl: queueUrl1, MessageBody: 'message 1'}).promise()
        await sqs.sendMessage({QueueUrl: queueUrl1, MessageBody: 'message 2 - test'}).promise()
        await sqs.sendMessage({QueueUrl: queueUrl1, MessageBody: 'message 3'}).promise()
        await sqs.sendMessage({QueueUrl: queueUrl1, MessageBody: 'message 4 - test'}).promise()
    });
    afterEach(async function() {
        await sqs.deleteQueue({QueueUrl: queueUrl1}).promise();
        await sqs.deleteQueue({QueueUrl: queueUrl2}).promise();
        await sqs.deleteQueue({QueueUrl: queueUrl3}).promise();
    });
    const getQueueAttribute = async (queueUrl, attribute) => {
        const queueAttributes = await sqs.getQueueAttributes({
            QueueUrl: queueUrl,
            AttributeNames: [attribute]
        }).promise();
        return queueAttributes.Attributes[attribute];
    }
    it('should scan the queue', async function () {
        // act
        const {qtyScanned, qtyMatched} = await new SqsGrep(sqs, parseOptions(['--queue=Queue1', '--body=test']), emptyLog).run();
        
        // assert
        assert.equal(qtyScanned, 4);
        assert.equal(qtyMatched, 2);
    });
    it('should copy the queue', async function () {
        // act
        const {qtyScanned, qtyMatched} = await new SqsGrep(sqs, parseOptions(['--queue=Queue1', '--copyTo=Queue2', '--body=test']), emptyLog).run();
        
        // assert
        assert.equal(qtyScanned, 4);
        assert.equal(qtyMatched, 2);
        assert.equal(await getQueueAttribute(queueUrl2, 'ApproximateNumberOfMessages'), 2);
        assert.equal(await getQueueAttribute(queueUrl1, 'ApproximateNumberOfMessagesNotVisible'), 4);
    });
    it('should move the queue', async function () {
        // act
        const {qtyScanned, qtyMatched} = await new SqsGrep(sqs, parseOptions(['--queue=Queue1', '--moveTo=Queue2', '--body=test']), emptyLog).run();
        
        // assert
        assert.equal(qtyScanned, 4);
        assert.equal(qtyMatched, 2);
        assert.equal(await getQueueAttribute(queueUrl2, 'ApproximateNumberOfMessages'), 2);
        assert.equal(await getQueueAttribute(queueUrl1, 'ApproximateNumberOfMessages'), 0);
        assert.equal(await getQueueAttribute(queueUrl1, 'ApproximateNumberOfMessagesNotVisible'), 2);
    });
    it('should move and copy the queue', async function () {
        // act
        const {qtyScanned, qtyMatched} = await new SqsGrep(sqs, parseOptions(['--queue=Queue1', '--moveTo=Queue2', '--copyTo=Queue3', '--body=test']), emptyLog).run();
        
        // assert
        assert.equal(qtyScanned, 4);
        assert.equal(qtyMatched, 2);
        assert.equal(await getQueueAttribute(queueUrl2, 'ApproximateNumberOfMessages'), 2);
        assert.equal(await getQueueAttribute(queueUrl3, 'ApproximateNumberOfMessages'), 2);
        assert.equal(await getQueueAttribute(queueUrl1, 'ApproximateNumberOfMessages'), 0);
        assert.equal(await getQueueAttribute(queueUrl1, 'ApproximateNumberOfMessagesNotVisible'), 2);
    });
});
