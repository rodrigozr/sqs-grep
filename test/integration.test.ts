import {SNS} from '@aws-sdk/client-sns';
import {SQS, type QueueAttributeName, type GetQueueAttributesResult} from '@aws-sdk/client-sqs';
import util from 'util';
import https from 'https';
import path from 'path';
import {exec as execCb} from 'child_process';
const exec = util.promisify(execCb);
import assert from 'assert';
import sinon from 'sinon';
import {parseOptions, type SqsGrepOptions} from '../src/options.js';
import {SqsGrep} from '../src/sqs-grep.js';

const emptyLog = sinon.stub();

/**
 * AWS Emulator release used by the integration tests (https://docs.aws.amazon.com/emulator/).
 * Pinned for reproducible test runs: a new release can change fidelity, so bump
 * it deliberately. Published versions are listed in
 * https://downloads.aws.com/aws-emulator/packages/aws-emulator/LTS/versions.json
 */
const AWS_EMULATOR_VERSION = '1.0.337';

/**
 * AWS does not publish a prebuilt image, so it is built locally from
 * test/aws-emulator/Dockerfile. The tag carries the version, so bumping
 * AWS_EMULATOR_VERSION rebuilds the image, while later runs reuse it.
 */
const EMULATOR_IMAGE = `sqs-grep-aws-emulator:${AWS_EMULATOR_VERSION}`;

/** Directory holding the Dockerfile (npm scripts run from the package root) */
const EMULATOR_DOCKERFILE_DIR = path.join(process.cwd(), 'test', 'aws-emulator');

/** HTTPS port the emulator listens on (its default), published on 127.0.0.1 only */
const EMULATOR_PORT = 9297;

/**
 * Where the emulator writes the credentials and certificate of its current run,
 * inside the container. Both are regenerated on every start, so they are read
 * from the running container rather than mounted onto the host.
 */
const EMULATOR_FILES_DIR = `/home/emulator/.aws/emulator/${EMULATOR_PORT}`;

/**
 * Reads the credentials and certificate that the emulator generated for this run.
 * Fails until the emulator has written them, so it doubles as a readiness probe.
 * @param containerCli the container CLI
 * @param containerName the emulator container
 * @returns the access key pair and the CA certificate in PEM format
 */
async function readEmulatorFiles(containerCli: string, containerName: string): Promise<{accessKeyId: string, secretAccessKey: string, ca: string}> {
    const read = async (file: string): Promise<string> =>
        (await exec(`${containerCli} exec ${containerName} cat ${EMULATOR_FILES_DIR}/${file}`)).stdout;
    // emulator_credentials is an AWS shared credentials file with a [default] profile
    const credentials = await read('emulator_credentials');
    const accessKeyId = /^\s*aws_access_key_id\s*=\s*(\S+)/m.exec(credentials)?.[1];
    const secretAccessKey = /^\s*aws_secret_access_key\s*=\s*(\S+)/m.exec(credentials)?.[1];
    if (!accessKeyId || !secretAccessKey) {
        throw new Error('The emulator credentials file does not contain the keys yet');
    }
    return {accessKeyId, secretAccessKey, ca: await read('ca.pem')};
}

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
            try {
                await exec(`${containerCli} image inspect ${EMULATOR_IMAGE}`);
            } catch {
                // Only the first run (or a version bump) pays for the ~150 MB download
                console.log(`    Building the ${EMULATOR_IMAGE} image using '${containerCli}'...`);
                await exec(`${containerCli} build -t ${EMULATOR_IMAGE} --build-arg AWS_EMULATOR_VERSION=${AWS_EMULATOR_VERSION} "${EMULATOR_DOCKERFILE_DIR}"`);
            }
            console.log(`    Starting the ${EMULATOR_IMAGE} container using '${containerCli}'...`);
            try {
                await exec(`${containerCli} rm -f ${containerName}`);
            } catch {
                /* ignore - the container did not exist */
            }
            // Telemetry is turned off for test runs, and the idle timeout stops a
            // container that the 'after' hook did not get to remove
            await exec(`${containerCli} run -d --name ${containerName} --memory=2g`
                + ` -p 127.0.0.1:${EMULATOR_PORT}:${EMULATOR_PORT} ${EMULATOR_IMAGE}`
                + ` -p ${EMULATOR_PORT} --telemetry off --idle-timeout 900`);
            // Wait for it to be ready for a maximum of 2 minutes (it usually takes a
            // second or two). The emulator generates new credentials and a new HTTPS
            // certificate on every start, so readiness means: both files are written
            // and the SDK, which is what the tests need, gets answers with them
            const deadline = new Date().getTime() + (2 * 60 * 1000);
            let lastError: unknown;
            while (new Date().getTime() < deadline) {
                try {
                    const {accessKeyId, secretAccessKey, ca} = await readEmulatorFiles(containerCli, containerName);
                    // The credentials are passed explicitly rather than through the
                    // environment, as the SDK ignores AWS_ACCESS_KEY_ID and
                    // AWS_SECRET_ACCESS_KEY whenever AWS_PROFILE happens to be set.
                    // The certificate is trusted by these clients only, instead of
                    // through NODE_EXTRA_CA_CERTS, which is read when Node.js starts.
                    // 127.0.0.1 rather than localhost, as the emulator requires
                    const options = parseOptions(['--endpointUrl', `https://127.0.0.1:${EMULATOR_PORT}`]);
                    const clientConfig = {
                        region: options.region,
                        endpoint: options.endpointUrl,
                        credentials: {accessKeyId, secretAccessKey},
                        requestHandler: {httpsAgent: new https.Agent({ca})},
                    };
                    sqs = new SQS(clientConfig);
                    sns = new SNS(clientConfig);
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
            // here is a real problem (image build, port already in use, ...)
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
    // Like SQS, the emulator refuses to re-create a queue within 60 seconds of
    // deleting one with the same name (QueueDeletedRecently), so every test uses
    // its own queue names
    let testNumber = 0;
    let queueName1 = '', queueName2 = '', queueName3 = '', queueName4 = '', fifoQueueName = '';
    beforeEach(async function() {
        testNumber++;
        queueName1 = `Queue1-${testNumber}`;
        queueName2 = `Queue2-${testNumber}`;
        queueName3 = `Queue3-${testNumber}`;
        queueName4 = `Queue4-${testNumber}`;
        fifoQueueName = `Queue-${testNumber}.fifo`;
        queueUrl1 = (await sqs.createQueue({QueueName: queueName1})).QueueUrl;
        queueAttributes1 = await sqs.getQueueAttributes({
            QueueUrl: queueUrl1,
            AttributeNames: ['All']
        });
        queueUrl2 = (await sqs.createQueue({QueueName: queueName2})).QueueUrl;
        queueUrl3 = (await sqs.createQueue({
            QueueName: queueName3,
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
    /**
     * Subscribes a queue to a topic. Like on AWS, the emulator only delivers the
     * topic's messages when the queue policy allows the topic to send them
     */
    const subscribeQueue = async (topicArn: string | undefined, queueUrl: string | undefined): Promise<void> => {
        const queueArn = await getQueueAttribute(queueUrl, 'QueueArn');
        await sqs.setQueueAttributes({
            QueueUrl: queueUrl,
            Attributes: {
                Policy: JSON.stringify({
                    Version: '2012-10-17',
                    Statement: [{
                        Effect: 'Allow',
                        Principal: {Service: 'sns.amazonaws.com'},
                        Action: 'sqs:SendMessage',
                        Resource: queueArn,
                        Condition: {ArnEquals: {'aws:SourceArn': topicArn}},
                    }],
                }),
            },
        });
        await sns.subscribe({Protocol: 'sqs', TopicArn: topicArn, Endpoint: queueArn});
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
        const {qtyScanned, qtyMatched} = (await new SqsGrep(parse([`--queue=${queueName1}`, '--body=test'])).run())!;
        
        // assert
        assert.equal(qtyScanned, 4);
        assert.equal(qtyMatched, 2);
    });
    it('should copy the queue', async function () {
        // act
        const {qtyScanned, qtyMatched} = (await new SqsGrep(parse([`--queue=${queueName1}`, `--copyTo=${queueName2}`, '--body=test'])).run())!;
        
        // assert
        assert.equal(qtyScanned, 4);
        assert.equal(qtyMatched, 2);
        assert.equal(await getQueueAttribute(queueUrl2, 'ApproximateNumberOfMessages'), 2);
        assert.equal(await getQueueAttribute(queueUrl1, 'ApproximateNumberOfMessagesNotVisible'), 4);
    });
    it('should publish the queue', async function () {
        // arrange
        const topic = (await sns.createTopic({Name: 'MyTopic'})).TopicArn;
        await subscribeQueue(topic, queueUrl2);
        
        // act
        const {qtyScanned, qtyMatched} = (await new SqsGrep(parse([`--queue=${queueName1}`, '--publishTo', topic!, '--body=test'])).run())!;
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
        await subscribeQueue(topic, queueUrl2);
        await sns.publish({
            TopicArn: topic,
            Message: "test publish",
        });
        await new SqsGrep(parse([`--queue=${queueName2}`, `--moveTo=${queueName3}`, '--body=publish'])).run();
        
        // act
        const {qtyScanned, qtyMatched} = (await new SqsGrep(parse([`--queue=${queueName3}`, '--delete', '--republish', '--body=publish'])).run())!;
        
        // assert
        assert.equal(qtyScanned, 1);
        assert.equal(qtyMatched, 1);
        assert.equal(await getQueueAttribute(queueUrl2, 'ApproximateNumberOfMessages'), 1);
        assert.equal(await getQueueAttribute(queueUrl3, 'ApproximateNumberOfMessages'), 0);
        assert.equal(await getQueueAttribute(queueUrl3, 'ApproximateNumberOfMessagesNotVisible'), 0);
    });
    it('should move the queue', async function () {
        // act
        const {qtyScanned, qtyMatched} = (await new SqsGrep(parse([`--queue=${queueName1}`, `--moveTo=${queueName2}`, '--body=test'])).run())!;
        
        // assert
        assert.equal(qtyScanned, 4);
        assert.equal(qtyMatched, 2);
        assert.equal(await getQueueAttribute(queueUrl2, 'ApproximateNumberOfMessages'), 2);
        assert.equal(await getQueueAttribute(queueUrl1, 'ApproximateNumberOfMessages'), 0);
        assert.equal(await getQueueAttribute(queueUrl1, 'ApproximateNumberOfMessagesNotVisible'), 2);
    });
    it('should move and copy the queue', async function () {
        // act
        const {qtyScanned, qtyMatched} = (await new SqsGrep(parse([`--queue=${queueName1}`, `--moveTo=${queueName2}`, `--copyTo=${queueName3}`, '--body=test'])).run())!;
        
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
        const {qtyScanned, qtyMatched} = (await new SqsGrep(parse([`--queue=${queueName1}`, '--redrive', '--body=test'])).run())!;
        
        // assert
        assert.equal(qtyScanned, 4);
        assert.equal(qtyMatched, 2);
        assert.equal(await getQueueAttribute(queueUrl3, 'ApproximateNumberOfMessages'), 2);
        assert.equal(await getQueueAttribute(queueUrl1, 'ApproximateNumberOfMessages'), 0);
        assert.equal(await getQueueAttribute(queueUrl1, 'ApproximateNumberOfMessagesNotVisible'), 2);
    });
    it('should fail redrive when there are no source queues', async function () {
        // act, assert
        await assert.rejects(() => new SqsGrep(parse([`--queue=${queueName2}`, '--redrive', '--all'])).run(),
            (err: Error) => err.message.includes('ERROR - Could not find source queue for dead-letter'));
    });
    it('should fail redrive when there are multiple source queues', async function () {
        // arrange
        await sqs.createQueue({
            QueueName: queueName4,
            Attributes: {
                RedrivePolicy: JSON.stringify({
                    maxReceiveCount: 10,
                    deadLetterTargetArn: queueAttributes1.Attributes?.QueueArn
                })
            }
        });

        // act, assert
        await assert.rejects(() => new SqsGrep(parse([`--queue=${queueName1}`, '--redrive', '--all'])).run(),
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
        const fifoQueueUrl = (await sqs.createQueue({QueueName: fifoQueueName, Attributes: attr})).QueueUrl;
        await sqs.sendMessage({QueueUrl: fifoQueueUrl, MessageGroupId: '1', MessageBody: 'message 1'});
        await sqs.sendMessage(
            {QueueUrl: fifoQueueUrl, MessageGroupId: '1', MessageBody: 'message 2 - test'}
        );

        // act
        const {qtyScanned, qtyMatched} = (await new SqsGrep(parse([`--queue=${fifoQueueName}`, `--moveTo=${queueName2}`, `--copyTo=${queueName3}`, '--body=test'])).run())!;
        
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
        const fifoQueueUrl = (await sqs.createQueue({QueueName: fifoQueueName, Attributes: attr})).QueueUrl;

        // act
        const {qtyScanned, qtyMatched} = (await new SqsGrep(parse([`--queue=${queueName1}`, `--copyTo=${fifoQueueName}`, '--body=test'])).run())!;
        
        // assert
        assert.equal(qtyScanned, 4);
        assert.equal(qtyMatched, 2);
        assert.equal(await getQueueAttribute(fifoQueueUrl, 'ApproximateNumberOfMessages'), 2);
    });
    it('should limit max TPS', async function () {
        // arrange
        const startTime = Date.now();

        // act
        await new SqsGrep(parse(['--maxTPS=4', `--queue=${queueName1}`, `--moveTo=${queueName2}`, `--copyTo=${queueName3}`, '--all'])).run();
        const elapsedTime = Date.now() - startTime;
        
        // assert
        //   (one message processed every 250ms, with the first one being immediate)
        assert(elapsedTime >= 750);
    });

});
