import {SNS} from '@aws-sdk/client-sns';
import {SQS, type QueueAttributeName, type GetQueueAttributesResult} from '@aws-sdk/client-sqs';
import util from 'util';
import {exec as execCb} from 'child_process';
const exec = util.promisify(execCb);
import assert from 'assert';
import sinon from 'sinon';
import {parseOptions, type SqsGrepOptions} from '../src/options.js';
import {SqsGrep} from '../src/sqs-grep.js';

const emptyLog = sinon.stub();

/**
 * Container image providing a local AWS emulator with SQS and SNS.
 *
 * Floci is used since LocalStack folded its community edition into the licensed
 * image in March 2026 (every release from 2026.x on refuses to start without a
 * LOCALSTACK_AUTH_TOKEN). Floci is MIT licensed, keeps LocalStack's port, health
 * endpoint and credentials conventions, and passes this whole suite unchanged.
 * Pinned to a release for reproducible test runs.
 */
const EMULATOR_IMAGE = 'floci/floci:2.1.0';

/**
 * Container CLIs which can run the emulator container. They all accept the same
 * `run`/`rm` arguments used below. Note that a shell alias (such as
 * `alias docker=finch`) is not visible to `child_process.exec`, hence the probing.
 * Set CONTAINER_CLI to force a specific one.
 */
const CONTAINER_CLI_CANDIDATES = ['docker', 'finch', 'podman', 'nerdctl'];

/**
 * Finds the first working container CLI
 * @returns the CLI command, or undefined when none is available
 */
async function detectContainerCli(): Promise<string | undefined> {
    const candidates = process.env['CONTAINER_CLI'] ? [process.env['CONTAINER_CLI']] : CONTAINER_CLI_CANDIDATES;
    for (const cli of candidates) {
        try {
            // 'info' (unlike '--version') also fails when the daemon / VM is not running
            await exec(`${cli} info`);
            return cli;
        } catch {
            // try the next one
        }
    }
    return undefined;
}

describe('Integration Tests', function () {
    // Note: the container name must be visible to both the 'before' and 'after' hooks
    const containerName = 'sqs-grep-integration-tests';
    let containerCli: string | undefined;
    let sqs = new SQS();
    let sns = new SNS();
    before(async function() {
        if (!process.env['RUN_INTEGRATION_TESTS']) {
            console.log('    Skipping integration tests because RUN_INTEGRATION_TESTS was not defined');
            this.skip();
            return;
        }
        this.timeout(6 * 60 * 1000);
        containerCli = await detectContainerCli();
        if (!containerCli) {
            console.log(`    Skipping integration tests because no working container CLI was found (tried: ${CONTAINER_CLI_CANDIDATES.join(', ')})`);
            this.skip();
            return;
        }
        try {
            console.log(`    Starting the ${EMULATOR_IMAGE} container using '${containerCli}'...`);
            try {
                await exec(`${containerCli} rm -f ${containerName}`);
            } catch {
                /* ignore - the container did not exist */
            }
            await exec(`${containerCli} run -d --name ${containerName} -p 4566:4566 ${EMULATOR_IMAGE}`);
            // The emulator accepts any credentials. They are passed explicitly rather
            // than through the environment, as the SDK ignores AWS_ACCESS_KEY_ID and
            // AWS_SECRET_ACCESS_KEY whenever AWS_PROFILE happens to be set
            const options = parseOptions(['--endpointUrl', 'http://localhost:4566']);
            const clientConfig = {
                region: options.region,
                endpoint: options.endpointUrl,
                credentials: {accessKeyId: 'test', secretAccessKey: 'test'},
            };
            sqs = new SQS(clientConfig);
            sns = new SNS(clientConfig);
            // Wait for it to be ready for a maximum of 2 minutes (it usually takes a
            // couple of seconds, but the image may have to be pulled first). Readiness
            // is probed through the SDK itself, which is what the tests need to work,
            // rather than by watching the container logs
            const deadline = new Date().getTime() + (2 * 60 * 1000);
            let lastError: unknown;
            while (new Date().getTime() < deadline) {
                try {
                    await sqs.createQueue({QueueName: 'ReadyTest'});
                    await sns.listTopics({});
                    // Success - the container is ready to be used!
                    return;
                } catch (ex) {
                    lastError = ex;
                }
                // Wait 250ms...
                await new Promise(resolve => setTimeout(resolve, 250));
            }
            throw new Error(`Timed out waiting for the ${EMULATOR_IMAGE} container to become ready (last error: ${String(lastError)})`);
        } catch (err) {
            // Do not hide the real cause: a container CLI is available, so a failure
            // here is a real problem (image pull, port already in use, ...)
            console.log(`    ERROR: Could not start the ${EMULATOR_IMAGE} container using '${containerCli}':`);
            console.log(`    ${(err as Error).message.trim().split('\n').join('\n    ')}`);
            throw err;
        }
    });
    after(async function() {
        this.timeout(20000);
        if (!containerCli) {
            return;
        }
        try {
            console.log('    Removing the emulator container...');
            await exec(`${containerCli} rm -f ${containerName}`);
        } catch {
            /* ignore */
        }
    });
    let queueUrl1: string | undefined, queueUrl2: string | undefined, queueUrl3: string | undefined, queueAttributes1: GetQueueAttributesResult;
    beforeEach(async function() {
        queueUrl1 = (await sqs.createQueue({QueueName: 'Queue1'})).QueueUrl;
        queueAttributes1 = await sqs.getQueueAttributes({
            QueueUrl: queueUrl1,
            AttributeNames: ['All']
        });
        queueUrl2 = (await sqs.createQueue({QueueName: 'Queue2'})).QueueUrl;
        queueUrl3 = (await sqs.createQueue({
            QueueName: 'Queue3',
            Attributes: {
                RedrivePolicy: JSON.stringify({
                    maxReceiveCount: 10,
                    deadLetterTargetArn: queueAttributes1.Attributes?.QueueArn
                })
            }
        })).QueueUrl;

        await sqs.sendMessage({QueueUrl: queueUrl1, MessageBody: 'message 1'});
        await sqs.sendMessage({QueueUrl: queueUrl1, MessageBody: 'message 2 - test'});
        await sqs.sendMessage({QueueUrl: queueUrl1, MessageBody: 'message 3'});
        await sqs.sendMessage({QueueUrl: queueUrl1, MessageBody: 'message 4 - test'});
    });
    afterEach(async function() {
        const queues = (await sqs.listQueues({})).QueueUrls ?? [];
        for (const url of queues) {
            await sqs.deleteQueue({QueueUrl: url});
        }
    });
    const getQueueAttribute = async (queueUrl: string | undefined, attribute: QueueAttributeName): Promise<string | undefined> => {
        const queueAttributes = await sqs.getQueueAttributes({
            QueueUrl: queueUrl,
            AttributeNames: [attribute]
        });
        return queueAttributes.Attributes?.[attribute];
    };
    const parse = (args: string[]): SqsGrepOptions => ({
        sqs, sns,
        // Both channels are silenced: diagnostics (log) and matched messages (out)
        log: emptyLog,
        out: emptyLog,
        ...parseOptions(args)
    });
    it('should scan the queue', async function () {
        // act
        const {qtyScanned, qtyMatched} = (await new SqsGrep(parse(['--queue=Queue1', '--body=test'])).run())!;
        
        // assert
        assert.equal(qtyScanned, 4);
        assert.equal(qtyMatched, 2);
    });
    it('should copy the queue', async function () {
        // act
        const {qtyScanned, qtyMatched} = (await new SqsGrep(parse(['--queue=Queue1', '--copyTo=Queue2', '--body=test'])).run())!;
        
        // assert
        assert.equal(qtyScanned, 4);
        assert.equal(qtyMatched, 2);
        assert.equal(await getQueueAttribute(queueUrl2, 'ApproximateNumberOfMessages'), 2);
        assert.equal(await getQueueAttribute(queueUrl1, 'ApproximateNumberOfMessagesNotVisible'), 4);
    });
    it('should publish the queue', async function () {
        // arrange
        const topic = (await sns.createTopic({Name: 'MyTopic'})).TopicArn;
        const queueArn = await getQueueAttribute(queueUrl2, 'QueueArn');
        await sns.subscribe({
            Protocol: 'sqs',
            TopicArn: topic,
            Endpoint: queueArn,
        });
        
        // act
        const {qtyScanned, qtyMatched} = (await new SqsGrep(parse(['--queue=Queue1', '--publishTo', topic!, '--body=test'])).run())!;
        await new Promise(resolve => setTimeout(resolve, 50));
        
        // assert
        assert.equal(qtyScanned, 4);
        assert.equal(qtyMatched, 2);
        assert.equal(await getQueueAttribute(queueUrl2, 'ApproximateNumberOfMessages'), 2);
        assert.equal(await getQueueAttribute(queueUrl1, 'ApproximateNumberOfMessagesNotVisible'), 4);
    });
    it('should re-publish messages to the original queue', async function () {
        // arrange
        const topic = (await sns.createTopic({Name: 'MyTopicForRepublish'})).TopicArn;
        const queueArn = await getQueueAttribute(queueUrl2, 'QueueArn');
        await sns.subscribe({
            Protocol: 'sqs',
            TopicArn: topic,
            Endpoint: queueArn,
        });
        await sns.publish({
            TopicArn: topic,
            Message: "test publish",
        });
        await new SqsGrep(parse(['--queue=Queue2', '--moveTo=Queue3', '--body=publish'])).run();
        
        // act
        const {qtyScanned, qtyMatched} = (await new SqsGrep(parse(['--queue=Queue3', '--delete', '--republish', '--body=publish'])).run())!;
        
        // assert
        assert.equal(qtyScanned, 1);
        assert.equal(qtyMatched, 1);
        assert.equal(await getQueueAttribute(queueUrl2, 'ApproximateNumberOfMessages'), 1);
        assert.equal(await getQueueAttribute(queueUrl3, 'ApproximateNumberOfMessages'), 0);
        assert.equal(await getQueueAttribute(queueUrl3, 'ApproximateNumberOfMessagesNotVisible'), 0);
    });
    it('should move the queue', async function () {
        // act
        const {qtyScanned, qtyMatched} = (await new SqsGrep(parse(['--queue=Queue1', '--moveTo=Queue2', '--body=test'])).run())!;
        
        // assert
        assert.equal(qtyScanned, 4);
        assert.equal(qtyMatched, 2);
        assert.equal(await getQueueAttribute(queueUrl2, 'ApproximateNumberOfMessages'), 2);
        assert.equal(await getQueueAttribute(queueUrl1, 'ApproximateNumberOfMessages'), 0);
        assert.equal(await getQueueAttribute(queueUrl1, 'ApproximateNumberOfMessagesNotVisible'), 2);
    });
    it('should move and copy the queue', async function () {
        // act
        const {qtyScanned, qtyMatched} = (await new SqsGrep(parse(['--queue=Queue1', '--moveTo=Queue2', '--copyTo=Queue3', '--body=test'])).run())!;
        
        // assert
        assert.equal(qtyScanned, 4);
        assert.equal(qtyMatched, 2);
        assert.equal(await getQueueAttribute(queueUrl2, 'ApproximateNumberOfMessages'), 2);
        assert.equal(await getQueueAttribute(queueUrl3, 'ApproximateNumberOfMessages'), 2);
        assert.equal(await getQueueAttribute(queueUrl1, 'ApproximateNumberOfMessages'), 0);
        assert.equal(await getQueueAttribute(queueUrl1, 'ApproximateNumberOfMessagesNotVisible'), 2);
    });
    it('should redrive the queue', async function () {
        // act
        const {qtyScanned, qtyMatched} = (await new SqsGrep(parse(['--queue=Queue1', '--redrive', '--body=test'])).run())!;
        
        // assert
        assert.equal(qtyScanned, 4);
        assert.equal(qtyMatched, 2);
        assert.equal(await getQueueAttribute(queueUrl3, 'ApproximateNumberOfMessages'), 2);
        assert.equal(await getQueueAttribute(queueUrl1, 'ApproximateNumberOfMessages'), 0);
        assert.equal(await getQueueAttribute(queueUrl1, 'ApproximateNumberOfMessagesNotVisible'), 2);
    });
    it('should fail redrive when there are no source queues', async function () {
        // act, assert
        await assert.rejects(() => new SqsGrep(parse(['--queue=Queue2', '--redrive', '--all'])).run(),
            (err: Error) => err.message.includes('ERROR - Could not find source queue for dead-letter'));
    });
    it('should fail redrive when there are multiple source queues', async function () {
        // arrange
        await sqs.createQueue({
            QueueName: 'Queue4',
            Attributes: {
                RedrivePolicy: JSON.stringify({
                    maxReceiveCount: 10,
                    deadLetterTargetArn: queueAttributes1.Attributes?.QueueArn
                })
            }
        });

        // act, assert
        await assert.rejects(() => new SqsGrep(parse(['--queue=Queue1', '--redrive', '--all'])).run(),
            (err: Error) => err.message.includes('ERROR - Found a total of 2 source queues for dead-letter'));
    });
    it('should support queue URLs', async function () {
        // act
        const {qtyScanned, qtyMatched} = (await new SqsGrep(parse(['--queue', queueUrl1!, '--moveTo', queueUrl2!, '--copyTo', queueUrl3!, '--body=test'])).run())!;
        
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
        const fifoQueueUrl = (await sqs.createQueue({QueueName: 'Queue.fifo', Attributes: attr})).QueueUrl;
        await sqs.sendMessage({QueueUrl: fifoQueueUrl, MessageGroupId: '1', MessageBody: 'message 1'});
        await sqs.sendMessage(
            {QueueUrl: fifoQueueUrl, MessageGroupId: '1', MessageBody: 'message 2 - test'}
        );

        // act
        const {qtyScanned, qtyMatched} = (await new SqsGrep(parse(['--queue=Queue.fifo', '--moveTo=Queue2', '--copyTo=Queue3', '--body=test'])).run())!;
        
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
        const fifoQueueUrl = (await sqs.createQueue({QueueName: 'Queue.fifo', Attributes: attr})).QueueUrl;

        // act
        const {qtyScanned, qtyMatched} = (await new SqsGrep(parse(['--queue=Queue1', '--copyTo=Queue.fifo', '--body=test'])).run())!;
        
        // assert
        assert.equal(qtyScanned, 4);
        assert.equal(qtyMatched, 2);
        assert.equal(await getQueueAttribute(fifoQueueUrl, 'ApproximateNumberOfMessages'), 2);
    });
    it('should limit max TPS', async function () {
        // arrange
        const startTime = Date.now();

        // act
        await new SqsGrep(parse(['--maxTPS=4', '--queue=Queue1', '--moveTo=Queue2', '--copyTo=Queue3', '--all'])).run();
        const elapsedTime = Date.now() - startTime;
        
        // assert
        //   (one message processed every 250ms, with the first one being immediate)
        assert(elapsedTime >= 750);
    });

});
