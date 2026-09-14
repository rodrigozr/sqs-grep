import assert from 'assert';
import sinon from 'sinon';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {SNS} from '@aws-sdk/client-sns';
import {SQS} from '@aws-sdk/client-sqs';
import {parseOptions, type SqsGrepOptions} from '../src/options.js';
import type {SqsClient, SnsClient} from '../src/types.js';
import {SqsGrep, MESSAGE_INDEX, type SqsGrepMessage} from '../src/sqs-grep.js';

const emptyLog = sinon.stub();

/** An AWS client where every method used by sqs-grep is a sinon stub */
type Stubbed<T> = {[K in keyof T]: sinon.SinonStub};

describe('SqsGrep', function () {
    let sqs: Stubbed<SqsClient>, sns: Stubbed<SnsClient>;
    const parse = (args: string[]): SqsGrepOptions => ({
        ...parseOptions(args),
        sqs, sns,
        log: emptyLog
    });
    beforeEach(function() {
        sqs = {
            getQueueUrl: sinon.stub(),
            getQueueAttributes: sinon.stub(),
            sendMessage: sinon.stub(),
            deleteMessage: sinon.stub(),
            receiveMessage: sinon.stub(),
            listDeadLetterSourceQueues: sinon.stub(),
        };
        sqs.getQueueUrl.returns(Promise.resolve({QueueUrl: 'fake://url'}));
        sqs.getQueueAttributes.returns(Promise.resolve({Attributes: {ApproximateNumberOfMessages: 0}}));
        sqs.sendMessage.returns(Promise.resolve({}));
        sqs.deleteMessage.returns(Promise.resolve({}));
        sns = {
            getTopicAttributes: sinon.stub(),
            publish: sinon.stub(),
        };
        sns.getTopicAttributes.returns(Promise.resolve({}));
        sns.publish.returns(Promise.resolve({}));
    });
    afterEach(function() {
        sinon.restore();
        sinon.resetBehavior();
    });
    describe('#constructor()', function () {
        it('should support legacy parameters format', async function () {
            const options = parse(['--help']);
            delete options.log;
            delete options.sqs;
            const sqsGrep = new SqsGrep(sqs, options, emptyLog);
            assert.equal(sqsGrep.log, emptyLog);
            assert.equal(sqsGrep.sqs, sqs);
        });
        it('should default logger to console.log', async function () {
            const options = parse(['--help']);
            delete options.log;
            const sqsGrep = new SqsGrep(options);
            assert.equal(sqsGrep.log, console.log);
        });
        it('should default sqs to AWS SQS', async function () {
            const options = parse(['--help']);
            delete options.sqs;
            const sqsGrep = new SqsGrep(options);
            assert.equal(sqsGrep.sqs instanceof SQS, true);
        });
        it('should default sns to AWS SNS', async function () {
            const options = parse(['--help']);
            delete options.sns;
            const sqsGrep = new SqsGrep(options);
            assert.equal(sqsGrep.sns instanceof SNS, true);
        });
        it('should default all parameters', async function () {
            const sqsGrep = new SqsGrep({});
            assert.equal(sqsGrep.sqs instanceof SQS, true);
            assert.equal(sqsGrep.log, console.log);
            assert.equal(sqsGrep.options.parallel, 1);
        });
        it('should override default parameters', async function () {
            const sqsGrep = new SqsGrep({parallel: 2});
            assert.equal(sqsGrep.sqs instanceof SQS, true);
            assert.equal(sqsGrep.log, console.log);
            assert.equal(sqsGrep.options.parallel, 2);
        });
    });
    describe('#_getAwsOptions()', function () {
        it('should set the AWS region', async function () {
            const options = parse(['--region', 'us-west-2']);
            const opts = SqsGrep._getAwsOptions(options);
            assert.equal(opts.region, 'us-west-2');
        });
        it('should set static credentials when both the key id and secret are given', async function () {
            const options = parse(['--accessKeyId', 'KEY_ID', '--secretAccessKey', 'SECRET']);
            const opts = SqsGrep._getAwsOptions(options);
            assert.deepEqual(opts.credentials, {accessKeyId: 'KEY_ID', secretAccessKey: 'SECRET', sessionToken: undefined});
        });
        it('should set the sessionToken along with static credentials', async function () {
            const options = parse(['--accessKeyId', 'KEY_ID', '--secretAccessKey', 'SECRET', '--sessionToken', 'TOKEN']);
            const opts = SqsGrep._getAwsOptions(options);
            assert.deepEqual(opts.credentials, {accessKeyId: 'KEY_ID', secretAccessKey: 'SECRET', sessionToken: 'TOKEN'});
        });
        [['--accessKeyId', 'KEY_ID'], ['--secretAccessKey', 'SECRET'], ['--sessionToken', 'TOKEN']].forEach(args => {
            it(`should fall back to the default credential chain with only ${args[0]}`, async function () {
                const options = parse(args);
                const opts = SqsGrep._getAwsOptions(options);
                assert.equal(opts.credentials, undefined);
            });
        });
        it('should translate --maxRetries into SDK attempts', async function () {
            const options = parse(['--maxRetries', '5']);
            const opts = SqsGrep._getAwsOptions(options);
            assert.equal(opts.maxAttempts, 6, '5 retries means 6 attempts in total');
        });
        it('should set the endpointUrl', async function () {
            const options = parse(['--endpointUrl', 'http://localhost:5000']);
            const opts = SqsGrep._getAwsOptions(options);
            assert.equal(opts.endpoint, 'http://localhost:5000');
        });
    });
    describe('#run()', function () {
        it('should validate options and return null when invalid', async function () {
            const options = parse(['--help']);
            const sqsGrep = new SqsGrep(options);
            assert.equal(await sqsGrep.run(), null);
            assert.equal(emptyLog.called, true);
        });
        it('should scan all messages', async function () {
            // arrange
            const options = parse(['--queue=A', '--all']);
            const sqsGrep = new SqsGrep(options);
            sqs.receiveMessage.onFirstCall().returns(Promise.resolve({Messages: [
                {Body: '1'},
                {Body: '2'},
            ]}));
            sqs.receiveMessage.onSecondCall().returns(Promise.resolve({Messages: [
                {Body: '3'},
            ]}));
            [2,3,4,5,6].forEach(call => {
                sqs.receiveMessage.onCall(call).returns(Promise.resolve({Messages: []}));
            });
            
            // act
            const res = (await sqsGrep.run())!;

            // assert
            assert.equal(res.qtyScanned, 3);
            assert.equal(res.qtyMatched, 3);
        });

        it('should scan all messages with intermittent empty receives', async function () {
            // arrange
            const options = parse(['--queue=A', '--all']);
            const sqsGrep = new SqsGrep(options);
            sqs.receiveMessage.onFirstCall().returns(Promise.resolve({Messages: [
                {Body: '1'},
            ]}));
            [1,2,3,4].forEach(call => {
                sqs.receiveMessage.onCall(call).returns(Promise.resolve({Messages: []}));
            });
            sqs.receiveMessage.onCall(5).returns(Promise.resolve({Messages: [
                {Body: '2'},
            ]}));
            [6,7,8,9].forEach(call => {
                sqs.receiveMessage.onCall(call).returns(Promise.resolve({Messages: []}));
            });
            sqs.receiveMessage.onCall(10).returns(Promise.resolve({Messages: [
                {Body: '3'},
            ]}));
            [11,12,13,14,15].forEach(call => {
                sqs.receiveMessage.onCall(call).returns(Promise.resolve({Messages: []}));
            });
            
            // act
            const res = (await sqsGrep.run())!;

            // assert
            assert.equal(res.qtyScanned, 3);
            assert.equal(res.qtyMatched, 3);
        });

        it('should wait between empty receives', async function () {
            // arrange
            const clock = sinon.useFakeTimers();
            const options = parse(['--queue=A', '--all', '--wait=3', '--emptyReceives=3']);
            const sqsGrep = new SqsGrep(options);
            [0,1,2,3,4].forEach(call => {
                sqs.receiveMessage.onCall(call).returns(Promise.resolve({Messages: []}));
            });
            const originalDelay = sqsGrep._delay;
            let delayCalled = 0;
            sinon.replace(sqsGrep, '_delay', ms => {
                const res = originalDelay(ms);
                clock.tick(3000);
                delayCalled++;
                return res;
            });
            
            // act
            const resPromise = sqsGrep.run();
            const res = (await resPromise)!;

            // assert
            assert.equal(res.qtyScanned, 0);
            assert.equal(res.qtyMatched, 0);
            assert.equal(delayCalled, 2);
        });

        it('should limit max TPS with a valid TPS', async function () {
            // arrange
            const options = parse(['--queue=A', '--all', '--maxTPS=1', '--emptyReceives=1']);
            
            // act
            const sqsGrep = new SqsGrep(options);

            // assert            
            // Note:
            //  I could not find a way to reliably test the throttling.
            //  Even using sinon.useFakeTimers didn't work as expected with the "bottleneck"
            //  library, so I'm just checking if the function was properly wrapped
            //  when it should and the "real" test in the integration suite
            assert.equal(sqsGrep._processMatchedSqsMessage.name, 'wrapped');
        });

        it('should not limit max TPS with an invalid TPS', async function () {
            // arrange
            const options = parse(['--queue=A', '--all', '--maxTPS=9000', '--emptyReceives=1']);
            
            // act
            const sqsGrep = new SqsGrep(options);

            // assert            
            assert.equal(sqsGrep._processMatchedSqsMessage.name, '_processMatchedSqsMessage');
        });

        it('should filter messages', async function () {
            // arrange
            const options = parse(['--queue=A', '--body=2']);
            const sqsGrep = new SqsGrep(options);
            sqs.receiveMessage.onFirstCall().returns(Promise.resolve({Messages: [
                {Body: '1'},
                {Body: '2'},
            ]}));
            sqs.receiveMessage.onSecondCall().returns(Promise.resolve({Messages: [
                {Body: '3'},
            ]}));
            [2,3,4,5,6].forEach(call => {
                sqs.receiveMessage.onCall(call).returns(Promise.resolve({Messages: []}));
            });
            
            // act
            const res = (await sqsGrep.run())!;

            // assert
            assert.equal(res.qtyScanned, 3);
            assert.equal(res.qtyMatched, 1);
        });

        it('should filter messages by attributes', async function () {
            // arrange
            const options = parse(['--queue=A', '--attribute=key=val', '--silent']);
            const sqsGrep = new SqsGrep(options);
            sqs.receiveMessage.onFirstCall().returns(Promise.resolve({Messages: [
                {Body: '1', MessageAttributes:{key: {StringValue: 'val'}}},
                {Body: '2', MessageAttributes:{key: {StringValue: 'nop'}}},
            ]}));
            sqs.receiveMessage.onSecondCall().returns(Promise.resolve({Messages: [
                {Body: '3', MessageAttributes:{key: {StringValue: 'val'}}},
            ]}));
            [2,3,4,5,6].forEach(call => {
                sqs.receiveMessage.onCall(call).returns(Promise.resolve({Messages: []}));
            });
            
            // act
            const res = (await sqsGrep.run())!;

            // assert
            assert.equal(res.qtyScanned, 3);
            assert.equal(res.qtyMatched, 2);
        });

        it('should filter negated messages', async function () {
            // arrange
            const options = parse(['--queue=A', '--body=2', '--negate', '--full']);
            const sqsGrep = new SqsGrep(options);
            sqs.receiveMessage.onFirstCall().returns(Promise.resolve({Messages: [
                {Body: '1'},
                {Body: '2'},
            ]}));
            sqs.receiveMessage.onSecondCall().returns(Promise.resolve({Messages: [
                {Body: '3'},
            ]}));
            [2,3,4,5,6].forEach(call => {
                sqs.receiveMessage.onCall(call).returns(Promise.resolve({Messages: []}));
            });
            
            // act
            const res = (await sqsGrep.run())!;

            // assert
            assert.equal(res.qtyScanned, 3);
            assert.equal(res.qtyMatched, 2);
        });

        it('should raise downstream errors', async function () {
            // arrange
            const options = parse(['--queue=A', '--all']);
            const sqsGrep = new SqsGrep(options);
            sqs.receiveMessage.onFirstCall().returns(Promise.resolve({Messages: [
                {Body: '1'},
                {Body: '2'},
            ]}));
            sqs.receiveMessage.onSecondCall().returns(Promise.reject(new Error('Fake error')));
            
            // act, assert
            assert.rejects(sqsGrep.run(), new Error('Fake error'));
            assert.equal(sqsGrep.running, false);
        });

        it('should stop when interrupted after receive', async function () {
            // arrange
            const options = parse(['--queue=A', '--all']);
            const sqsGrep = new SqsGrep(options);
            sqs.receiveMessage.onFirstCall().returns(Promise.resolve({Messages: [
                {Body: '1'},
                {Body: '2'},
            ]}));
            sqs.receiveMessage.onSecondCall().callsFake(() => {
                sqsGrep.interrupt();
                return Promise.resolve({Messages: [
                    {Body: '3'},
                ]});
            });
                        
            // act
            const res = (await sqsGrep.run())!;

            // assert
            assert.equal(res.qtyScanned, 3);
            assert.equal(res.qtyMatched, 2);
            assert.equal(sqsGrep.running, false);
        });

        it('should stop when interrupted during message processing', async function () {
            // arrange
            const options = parse(['--queue=A', '--all']);
            const sqsGrep = new SqsGrep(options);
            sqs.receiveMessage.onFirstCall().returns(Promise.resolve({Messages: [
                {Body: '1'},
                {Body: '2'},
            ]}));
            sqs.receiveMessage.onSecondCall().returns(Promise.resolve({Messages: [
                {Body: '3'},
            ]}));
            const originalProcess = sqsGrep._processMatchedSqsMessage;
            sinon.stub(sqsGrep, '_processMatchedSqsMessage').callsFake(function (this: SqsGrep, message: SqsGrepMessage) {
                this.interrupt();
                return originalProcess.call(this, message);
            });
                        
            // act
            const res = (await sqsGrep.run())!;

            // assert
            assert.equal(res.qtyScanned, 2);
            assert.equal(res.qtyMatched, 1);
            assert.equal(sqsGrep.running, false);
        });

        it('should stop when maxMessages is reached', async function () {
            // arrange
            const options = parse(['--queue=A', '--all', '--maxMessages=3']);
            const sqsGrep = new SqsGrep(options);
            sqs.receiveMessage.onFirstCall().returns(Promise.resolve({Messages: [
                {Body: '1'},
                {Body: '2'},
                {Body: '3'},
                {Body: '4'},
                {Body: '5'},
            ]}));
            
            // act
            const res = (await sqsGrep.run())!;

            // assert
            assert.equal(res.qtyScanned, 5);
            assert.equal(res.qtyMatched, 3);
        });

        it('should stop when time exceeds', async function () {
            // arrange
            const clock = sinon.useFakeTimers();
            const options = parse(['--queue=A', '--all', '--timeout=8']);
            const sqsGrep = new SqsGrep(options);
            [0,1,2,3,4,5,6,7,8,9].forEach(messageNumber => {
                sqs.receiveMessage.onCall(messageNumber).callsFake(() => {
                    clock.tick(1000);
                    return Promise.resolve({Messages: [
                        {Body: 'Message ' + messageNumber},
                    ]});
                });
            });
            
            // act
            const res = (await sqsGrep.run())!;

            // assert
            assert.equal(res.qtyScanned, 8);
            assert.equal(res.qtyMatched, 7);
        });

        it('should copy messages', async function () {
            // arrange
            const options = parse(['--queue=A', '--all', '--copyTo=B']);
            const sqsGrep = new SqsGrep(options);
            sqs.receiveMessage.onFirstCall().returns(Promise.resolve({Messages: [
                {Body: '1', MessageAttributes:{key: {StringValue: 'val'}}},
                {Body: '2'},
            ]}));
            [1,2,3,4,5,6].forEach(call => {
                sqs.receiveMessage.onCall(call).returns(Promise.resolve({Messages: []}));
            });
            
            // act
            const res = (await sqsGrep.run())!;

            // assert
            assert.equal(sqs.getQueueUrl.callCount, 2);
            assert.equal(sqs.sendMessage.callCount, 2);
            assert.equal(sqs.sendMessage.firstCall.args[0].MessageAttributes.key.StringValue, 'val');
            assert.equal(sqs.sendMessage.secondCall.args[0].MessageAttributes, null);
            assert.equal(sqs.deleteMessage.callCount, 0);
            assert.equal(res.qtyScanned, 2);
            assert.equal(res.qtyMatched, 2);
        });

        it('should connect to queue URLs', async function () {
            // arrange
            const options = parse(['--queue=fake://queueA', '--all', '--copyTo=fake://queueB', '--moveTo=fake://queueC']);
            const sqsGrep = new SqsGrep(options);
            sqs.receiveMessage.onFirstCall().returns(Promise.resolve({Messages: [
                {Body: '1', MessageAttributes:{key: {StringValue: 'val'}}},
                {Body: '2'},
            ]}));
            [1,2,3,4,5,6].forEach(call => {
                sqs.receiveMessage.onCall(call).returns(Promise.resolve({Messages: []}));
            });
            
            // act
            const res = (await sqsGrep.run())!;

            // assert
            assert.equal(sqs.getQueueUrl.callCount, 0);
            assert.equal(sqs.sendMessage.callCount, 4);
            assert.equal(sqs.deleteMessage.callCount, 2);
            assert.equal(res.qtyScanned, 2);
            assert.equal(res.qtyMatched, 2);
        });

        it('should copy messages stripping attributes', async function () {
            // arrange
            const options = parse(['--queue=A', '--all', '--copyTo=B', '--stripAttributes']);
            const sqsGrep = new SqsGrep(options);
            sqs.receiveMessage.onFirstCall().returns(Promise.resolve({Messages: [
                {Body: '1', MessageAttributes:{key: {StringValue: 'val'}}},
                {Body: '2', MessageAttributes:{key: {StringValue: 'val'}}},
            ]}));
            [1,2,3,4,5,6].forEach(call => {
                sqs.receiveMessage.onCall(call).returns(Promise.resolve({Messages: []}));
            });
            
            // act
            const res = (await sqsGrep.run())!;

            // assert
            assert.equal(sqs.getQueueUrl.callCount, 2);
            assert.equal(sqs.sendMessage.callCount, 2);
            assert.equal(sqs.sendMessage.firstCall.args[0].MessageAttributes, null);
            assert.equal(sqs.sendMessage.secondCall.args[0].MessageAttributes, null);
            assert.equal(sqs.deleteMessage.callCount, 0);
            assert.equal(res.qtyScanned, 2);
            assert.equal(res.qtyMatched, 2);
        });

        it('should copy messages to FIFO queue', async function () {
            // arrange
            const options = parse(['--queue=A', '--all', '--copyTo=B.fifo']);
            const sqsGrep = new SqsGrep(options);
            sqs.receiveMessage.onFirstCall().returns(Promise.resolve({Messages: [
                {Body: '1', MessageAttributes:{key: {StringValue: 'val'}}, Attributes:{}, MessageId: 'id'},
                {Body: '2', MessageAttributes:{key: {StringValue: 'val'}}, Attributes:{MessageGroupId:'group', MessageDeduplicationId: 'dup'}},
            ]}));
            [1,2,3,4,5,6].forEach(call => {
                sqs.receiveMessage.onCall(call).returns(Promise.resolve({Messages: []}));
            });
            sqs.getQueueUrl.withArgs({QueueName:'B.fifo'}).returns(Promise.resolve({QueueUrl: 'fake://B.fifo'}));
                
            // act
            const res = (await sqsGrep.run())!;

            // assert
            assert.equal(sqs.getQueueUrl.callCount, 2);
            assert.equal(sqs.sendMessage.callCount, 2);
            assert.equal(sqs.sendMessage.firstCall.args[0].MessageGroupId, 'fifo');
            assert.equal(sqs.sendMessage.firstCall.args[0].MessageDeduplicationId, 'id');
            assert.equal(sqs.sendMessage.secondCall.args[0].MessageGroupId, 'group');
            assert.equal(sqs.sendMessage.secondCall.args[0].MessageDeduplicationId, 'dup');
            assert.equal(sqs.deleteMessage.callCount, 0);
            assert.equal(res.qtyScanned, 2);
            assert.equal(res.qtyMatched, 2);
        });

        it('should publish messages', async function () {
            // arrange
            const options = parse(['--queue=A', '--all', '--publishTo=FAKE_ARN']);
            const sqsGrep = new SqsGrep(options);
            sqs.receiveMessage.onFirstCall().returns(Promise.resolve({Messages: [
                {Body: '1', MessageAttributes:{key: {StringValue: 'val'}}},
                {Body: '2'},
            ]}));
            [1,2,3,4,5,6].forEach(call => {
                sqs.receiveMessage.onCall(call).returns(Promise.resolve({Messages: []}));
            });
            
            // act
            const res = (await sqsGrep.run())!;

            // assert
            assert.equal(sqs.getQueueUrl.callCount, 1);
            assert.equal(sns.getTopicAttributes.callCount, 1);
            assert.equal(sns.publish.callCount, 2);
            assert.equal(sns.publish.firstCall.args[0].MessageAttributes.key.StringValue, 'val');
            assert.equal(sns.publish.secondCall.args[0].MessageAttributes, null);
            assert.equal(sqs.deleteMessage.callCount, 0);
            assert.equal(res.qtyScanned, 2);
            assert.equal(res.qtyMatched, 2);
        });

        it('should handle messages without a Body', async function () {
            // arrange: --body must not match a missing body, and --publishTo /
            // --republish must not crash on it
            const options = parse(['--queue=A', '--body=.', '--publishTo=FAKE_ARN', '--republish']);
            const sqsGrep = new SqsGrep(options);
            sqs.receiveMessage.onFirstCall().returns(Promise.resolve({Messages: [
                {MessageId: 'no-body', MessageAttributes:{key: {StringValue: 'val'}}},
                {Body: 'has a body'},
            ]}));
            [1,2,3,4,5,6].forEach(call => {
                sqs.receiveMessage.onCall(call).returns(Promise.resolve({Messages: []}));
            });

            // act
            const res = (await sqsGrep.run())!;

            // assert
            assert.equal(res.qtyScanned, 2);
            assert.equal(res.qtyMatched, 1, 'A missing body must not match --body');
            assert.equal(sns.publish.callCount, 1);
            assert.equal(sns.publish.firstCall.args[0].Message, 'has a body');
        });

        it('should publish and republish messages without a Body when matched', async function () {
            // arrange: with --all the body-less message is matched, so the publish
            // paths must cope with the missing body without crashing
            const options = parse(['--queue=A', '--all', '--publishTo=FAKE_ARN', '--republish']);
            const sqsGrep = new SqsGrep(options);
            sqs.receiveMessage.onFirstCall().returns(Promise.resolve({Messages: [
                {MessageId: 'no-body', MessageAttributes:{key: {StringValue: 'val'}}},
            ]}));
            [1,2,3,4,5,6].forEach(call => {
                sqs.receiveMessage.onCall(call).returns(Promise.resolve({Messages: []}));
            });

            // act
            const res = (await sqsGrep.run())!;

            // assert
            assert.equal(res.qtyMatched, 1);
            assert.equal(sns.publish.callCount, 1, 'Published once to --publishTo; --republish ignores non-SNS messages');
            assert.equal(sns.publish.firstCall.args[0].Message, undefined);
            assert.equal(sns.publish.firstCall.args[0].MessageAttributes.key.StringValue, 'val');
        });

        it('should publish plain-text (non-JSON) messages as-is', async function () {
            // arrange: bodies which are not valid JSON must be published untouched,
            // with their own SQS message attributes
            const options = parse(['--queue=A', '--all', '--publishTo=FAKE_ARN']);
            const sqsGrep = new SqsGrep(options);
            sqs.receiveMessage.onFirstCall().returns(Promise.resolve({Messages: [
                {Body: 'not json at all', MessageAttributes:{key: {StringValue: 'val'}}},
                {Body: '{"Type":"Notification"'},
            ]}));
            [1,2,3,4,5,6].forEach(call => {
                sqs.receiveMessage.onCall(call).returns(Promise.resolve({Messages: []}));
            });

            // act
            const res = (await sqsGrep.run())!;

            // assert
            assert.equal(sns.publish.callCount, 2);
            assert.equal(sns.publish.firstCall.args[0].Message, 'not json at all');
            assert.equal(sns.publish.firstCall.args[0].MessageAttributes.key.StringValue, 'val');
            assert.equal(sns.publish.secondCall.args[0].Message, '{"Type":"Notification"');
            assert.equal(res.qtyMatched, 2);
        });

        it('should publish SNS notification without re-wrapping them', async function () {
            // arrange
            const options = parse(['--queue=A', '--all', '--publishTo=FAKE_ARN']);
            const sqsGrep = new SqsGrep(options);
            sqs.receiveMessage.onFirstCall().returns(Promise.resolve({Messages: [
                {Body: '{"Type":"Notification","Message":"1"}'},
                {Body: '2'},
            ]}));
            [1,2,3,4,5,6].forEach(call => {
                sqs.receiveMessage.onCall(call).returns(Promise.resolve({Messages: []}));
            });
            
            // act
            const res = (await sqsGrep.run())!;

            // assert
            assert.equal(sqs.getQueueUrl.callCount, 1);
            assert.equal(sns.getTopicAttributes.callCount, 1);
            assert.equal(sns.publish.callCount, 2);
            assert.equal(sns.publish.firstCall.args[0].Message, '1');
            assert.equal(sns.publish.secondCall.args[0].Message, '2');
            assert.equal(sqs.deleteMessage.callCount, 0);
            assert.equal(res.qtyScanned, 2);
            assert.equal(res.qtyMatched, 2);
        });

        it('should publish SNS notification with message attributes', async function () {
            // arrange
            const options = parse(['--queue=A', '--all', '--publishTo=FAKE_ARN']);
            const sqsGrep = new SqsGrep(options);
            sqs.receiveMessage.onFirstCall().returns(Promise.resolve({Messages: [
                {Body: '{"Type":"Notification","Message":"1","MessageAttributes":{"key":{"Value":"val","Type": "type"}}}'},
                {Body: '2', MessageAttributes:{key: {StringValue: 'val', DataType: 'type'}}},
            ]}));
            [1,2,3,4,5,6].forEach(call => {
                sqs.receiveMessage.onCall(call).returns(Promise.resolve({Messages: []}));
            });
            
            // act
            const res = (await sqsGrep.run())!;

            // assert
            assert.equal(sqs.getQueueUrl.callCount, 1);
            assert.equal(sns.getTopicAttributes.callCount, 1);
            assert.equal(sns.publish.callCount, 2);
            assert.equal(sns.publish.firstCall.args[0].Message, '1');
            assert.equal(sns.publish.firstCall.args[0].MessageAttributes.key.StringValue, 'val');
            assert.equal(sns.publish.firstCall.args[0].MessageAttributes.key.DataType, 'type');
            assert.equal(sns.publish.secondCall.args[0].Message, '2');
            assert.equal(sns.publish.secondCall.args[0].MessageAttributes.key.StringValue, 'val');
            assert.equal(sns.publish.secondCall.args[0].MessageAttributes.key.DataType, 'type');
            assert.equal(sqs.deleteMessage.callCount, 0);
            assert.equal(res.qtyScanned, 2);
            assert.equal(res.qtyMatched, 2);
        });

        it('should publish messages stripping attributes', async function () {
            // arrange
            const options = parse(['--queue=A', '--all', '--publishTo=FAKE_ARN', '--stripAttributes']);
            const sqsGrep = new SqsGrep(options);
            sqs.receiveMessage.onFirstCall().returns(Promise.resolve({Messages: [
                {Body: '1', MessageAttributes:{key: {StringValue: 'val'}}},
                {Body: '2'},
            ]}));
            [1,2,3,4,5,6].forEach(call => {
                sqs.receiveMessage.onCall(call).returns(Promise.resolve({Messages: []}));
            });
            
            // act
            const res = (await sqsGrep.run())!;

            // assert
            assert.equal(sqs.getQueueUrl.callCount, 1);
            assert.equal(sns.getTopicAttributes.callCount, 1);
            assert.equal(sns.publish.callCount, 2);
            assert.equal(sns.publish.firstCall.args[0].MessageAttributes, null);
            assert.equal(sns.publish.secondCall.args[0].MessageAttributes, null);
            assert.equal(sqs.deleteMessage.callCount, 0);
            assert.equal(res.qtyScanned, 2);
            assert.equal(res.qtyMatched, 2);
        });

        it('should republish SNS messages to their topic of origin', async function () {
            // arrange
            const options = parse(['--queue=A', '--all', '--republish']);
            const sqsGrep = new SqsGrep(options);
            sqs.receiveMessage.onFirstCall().returns(Promise.resolve({Messages: [
                {Body: '{"Type":"Notification","Message":"1", "TopicArn":"A"}'},
                {Body: '{"Type":"Notification","Message":"2", "TopicArn":"B"}'},
            ]}));
            [1,2,3,4,5,6].forEach(call => {
                sqs.receiveMessage.onCall(call).returns(Promise.resolve({Messages: []}));
            });

            // act
            const res = (await sqsGrep.run())!;

            // assert
            assert.equal(sqs.getQueueUrl.callCount, 1);
            assert.equal(sns.publish.callCount, 2);
            assert.equal(sns.publish.firstCall.args[0].Message, '1');
            assert.equal(sns.publish.firstCall.args[0].TopicArn, 'A');
            assert.equal(sns.publish.secondCall.args[0].Message, '2');
            assert.equal(sns.publish.secondCall.args[0].TopicArn, 'B');
            assert.equal(sqs.deleteMessage.callCount, 0);
            assert.equal(res.qtyScanned, 2);
            assert.equal(res.qtyMatched, 2);
        });

        it('should republish SNS messages with message attributes', async function () {
            // arrange
            const options = parse(['--queue=A', '--all', '--republish']);
            const sqsGrep = new SqsGrep(options);
            sqs.receiveMessage.onFirstCall().returns(Promise.resolve({Messages: [
                {Body: '{"Type":"Notification","Message":"1", "TopicArn":"A", "MessageAttributes":{"key":{"Value":"val","Type": "type"}}}'},
                {Body: '{"Type":"Notification","Message":"2", "TopicArn":"B"}'},
            ]}));
            [1,2,3,4,5,6].forEach(call => {
                sqs.receiveMessage.onCall(call).returns(Promise.resolve({Messages: []}));
            });

            // act
            const res = (await sqsGrep.run())!;

            // assert
            assert.equal(sqs.getQueueUrl.callCount, 1);
            assert.equal(sns.publish.callCount, 2);
            assert.equal(sns.publish.firstCall.args[0].Message, '1');
            assert.equal(sns.publish.firstCall.args[0].TopicArn, 'A');
            assert.equal(sns.publish.firstCall.args[0].MessageAttributes.key.StringValue, 'val');
            assert.equal(sns.publish.firstCall.args[0].MessageAttributes.key.DataType, 'type');
            assert.equal(sns.publish.secondCall.args[0].Message, '2');
            assert.equal(sns.publish.secondCall.args[0].TopicArn, 'B');
            assert.equal(sns.publish.secondCall.args[0].MessageAttributes, null);
            assert.equal(sqs.deleteMessage.callCount, 0);
            assert.equal(res.qtyScanned, 2);
            assert.equal(res.qtyMatched, 2);
        });

        it('should republish SNS messages stripping attributes', async function () {
            // arrange
            const options = parse(['--queue=A', '--all', '--republish', '--stripAttributes']);
            const sqsGrep = new SqsGrep(options);
            sqs.receiveMessage.onFirstCall().returns(Promise.resolve({Messages: [
                {Body: '{"Type":"Notification","Message":"1", "TopicArn":"A", "MessageAttributes":{"key":{"Value":"val","Type": "type"}}}'},
                {Body: '{"Type":"Notification","Message":"2", "TopicArn":"B"}'},
            ]}));
            [1,2,3,4,5,6].forEach(call => {
                sqs.receiveMessage.onCall(call).returns(Promise.resolve({Messages: []}));
            });

            // act
            const res = (await sqsGrep.run())!;

            // assert
            assert.equal(sqs.getQueueUrl.callCount, 1);
            assert.equal(sns.publish.callCount, 2);
            assert.equal(sns.publish.firstCall.args[0].MessageAttributes, null);
            assert.equal(sns.publish.secondCall.args[0].MessageAttributes, null);
            assert.equal(sqs.deleteMessage.callCount, 0);
            assert.equal(res.qtyScanned, 2);
            assert.equal(res.qtyMatched, 2);
        });

        it('should ignore messages with invalid body content when republishing', async function () {
            // arrange
            const options = parse(['--queue=A', '--all', '--republish']);
            const sqsGrep = new SqsGrep(options);
            sqs.receiveMessage.onFirstCall().returns(Promise.resolve({
                Messages: [
                    {Body: 'ABCD'}, // Non-JSON
                    {Body: '{"Type":"ABCD","Message":"1", "TopicArn":"A"}'}, // Type not Notification
                    {Body: '{"Type":"Notification", "TopicArn":"A"}'}, // No Message attribute
                    {Body: '{"Type":"Notification","Message":"1"}'} // No Topic Arn attribute
                ]
            }));
            [1,2,3,4,5,6].forEach(call => {
                sqs.receiveMessage.onCall(call).returns(Promise.resolve({Messages: []}));
            });

            // act
            const res = (await sqsGrep.run())!;

            // assert
            assert.equal(sqs.getQueueUrl.callCount, 1);
            assert.equal(sns.publish.callCount, 0);
            assert.equal(sqs.deleteMessage.callCount, 0);
            assert.equal(res.qtyScanned, 4);
            assert.equal(res.qtyMatched, 4);
        });

        it('should move messages', async function () {
            // arrange
            const options = parse(['--queue=A', '--all', '--moveTo=B']);
            const sqsGrep = new SqsGrep(options);
            sqs.receiveMessage.onFirstCall().returns(Promise.resolve({Messages: [
                {Body: '1'},
                {Body: '2'},
            ]}));
            [1,2,3,4,5,6].forEach(call => {
                sqs.receiveMessage.onCall(call).returns(Promise.resolve({Messages: []}));
            });
            
            // act
            const res = (await sqsGrep.run())!;

            // assert
            assert.equal(sqs.getQueueUrl.callCount, 2);
            assert.equal(sqs.sendMessage.callCount, 2);
            assert.equal(sqs.deleteMessage.callCount, 2);
            assert.equal(res.qtyScanned, 2);
            assert.equal(res.qtyMatched, 2);
        });

        it('should move and copy messages', async function () {
            // arrange
            const options = parse(['--queue=A', '--all', '--moveTo=B', '--copyTo=C']);
            const sqsGrep = new SqsGrep(options);
            sqs.receiveMessage.onFirstCall().returns(Promise.resolve({Messages: [
                {Body: '1'},
                {Body: '2'},
            ]}));
            [1,2,3,4,5,6].forEach(call => {
                sqs.receiveMessage.onCall(call).returns(Promise.resolve({Messages: []}));
            });
            
            // act
            const res = (await sqsGrep.run())!;

            // assert
            assert.equal(sqs.getQueueUrl.callCount, 3);
            assert.equal(sqs.sendMessage.callCount, 4);
            assert.equal(sqs.deleteMessage.callCount, 2);
            assert.equal(res.qtyScanned, 2);
            assert.equal(res.qtyMatched, 2);
        });

        it('should redrive messages', async function () {
            // arrange
            const options = parse(['--queue=A', '--all', '--redrive']);
            const sqsGrep = new SqsGrep(options);
            sqs.listDeadLetterSourceQueues.onFirstCall().returns(Promise.resolve({queueUrls: [
                'fake://queueA'
            ]}));
            sqs.receiveMessage.onFirstCall().returns(Promise.resolve({Messages: [
                {Body: '1'},
                {Body: '2'},
            ]}));
            [1,2,3,4,5,6].forEach(call => {
                sqs.receiveMessage.onCall(call).returns(Promise.resolve({Messages: []}));
            });
            
            // act
            const res = (await sqsGrep.run())!;

            // assert
            assert.equal(sqs.getQueueUrl.callCount, 1);
            assert.equal(sqs.sendMessage.callCount, 2);
            assert.equal(sqs.deleteMessage.callCount, 2);
            assert.equal(res.qtyScanned, 2);
            assert.equal(res.qtyMatched, 2);
        });

        it('should fail redrive without a source queue', async function () {
            // arrange
            const options = parse(['--queue=A', '--all', '--redrive']);
            const sqsGrep = new SqsGrep(options);
            sqs.listDeadLetterSourceQueues.onFirstCall().returns(Promise.resolve({}));
            
            // act, assert
            await assert.rejects(() => sqsGrep.run(),
                (err: Error) => err.message.includes('ERROR - Could not find source queue for dead-letter'));
        });

        it('should fail redrive with multiple source queues', async function () {
            // arrange
            const options = parse(['--queue=A', '--all', '--redrive']);
            const sqsGrep = new SqsGrep(options);
            sqs.listDeadLetterSourceQueues.onFirstCall().returns(Promise.resolve({queueUrls: [
                'fake://queueB',
                'fake://queueC',
                'fake://queueD',
            ]}));
            
            // act, assert
            await assert.rejects(() => sqsGrep.run(),
                (err: Error) => err.message.includes('ERROR - Found a total of 3 source queues for dead-letter'));
        });

        it('should write messages to file', async function () {
            // arrange
            try {
                fs.unlinkSync('.out');                
            } catch (err) {
                /* ignore */
            }
            const options = parse(['--queue=A', '--all', '--outputFile=.out']);
            const sqsGrep = new SqsGrep(options);
            sqs.receiveMessage.onFirstCall().returns(Promise.resolve({Messages: [
                {Body: '1'},
                {Body: '2'},
            ]}));
            sqs.receiveMessage.onSecondCall().returns(Promise.resolve({Messages: [
                {Body: '3'},
            ]}));
            [2,3,4,5,6].forEach(call => {
                sqs.receiveMessage.onCall(call).returns(Promise.resolve({Messages: []}));
            });
            
            // act
            const res = (await sqsGrep.run())!;

            // assert
            assert.equal(res.qtyScanned, 3);
            assert.equal(res.qtyMatched, 3);
            assert.equal(fs.readFileSync('.out', 'utf-8'), `{"Body":"1"}\n{"Body":"2"}\n{"Body":"3"}\n`);
            fs.unlinkSync('.out');
        });

        it('should read messages from file', async function () {
            // arrange
            try {
                fs.unlinkSync('.input');
            } catch (err) {
                /* ignore */
            }
            fs.writeFileSync('.input', `{"Body":"msg2","Attributes":{"SenderId":"AROAJDMDSGLKMLH45GQPG:rrosauro","ApproximateFirstReceiveTimestamp":"1575485575436","ApproximateReceiveCount":"2","SentTimestamp":"1575485516130"}}
            {"Body":"msg1","Attributes":{"SenderId":"AROAJDMDSGLKMLH45GQPG:rrosauro","ApproximateFirstReceiveTimestamp":"1575485574864","ApproximateReceiveCount":"2","SentTimestamp":"1575485512474"}}`, 'utf-8');
            const options = parse(['--inputFile=.input', '--body=msg2']);
            const sqsGrep = new SqsGrep(options);
            
            // act
            const res = (await sqsGrep.run())!;

            // assert
            assert.equal(res.qtyScanned, 2);
            assert.equal(res.qtyMatched, 1);
            fs.unlinkSync('.input');
        });

        it('should raise downstream errors writing to file system', async function () {
            // arrange
            const options = parse(['--queue=A', '--all', '--outputFile=.out']);
            const sqsGrep = new SqsGrep(options);
            sqs.receiveMessage.onFirstCall().returns(Promise.resolve({Messages: [
                {Body: '1'},
                {Body: '2'},
            ]}));
            sinon.replace(fs, 'appendFile', ((_file: unknown, _content: unknown, _encoding: unknown, callback: (err: Error) => void) => {
                callback(new Error('Fake error'));
            }) as unknown as typeof fs.appendFile);
            
            // act, assert
            assert.rejects(sqsGrep.run(), new Error('Fake error'));
            assert.equal(sqsGrep.running, false);
        });

        it('should log AWS calls when --verbose is set (custom log)', async function () {
            // arrange
            const options = parse(['--queue=A', '--all', '--verbose']);
            const log = (): void => undefined;
            options.log = log;

            // act
            const awsOptions = SqsGrep._getAwsOptions(options);

            // assert
            assert(awsOptions.logger?.info === log);
            assert(awsOptions.logger?.warn === log);
            assert(awsOptions.logger?.error === log);
            assert.equal(awsOptions.logger?.debug('ignored'), undefined, 'debug output must be silenced');
        });

        it('should log AWS calls when --verbose is set', async function () {
            // arrange
            const options = parse(['--queue=A', '--all', '--verbose']);
            options.log = undefined;

            // act
            const awsOptions = SqsGrep._getAwsOptions(options);

            // assert
            assert(awsOptions.logger?.info === console.log);
        });

        it('should call preProcessMessage user-script hook', async function () {
            // arrange
            const scriptFile = '/tmp/sqs-grep-test-script-1.js';
            const options = parse(['--queue=A', '--all', '--moveTo=B', '--scriptFile', scriptFile]);
            sqs.receiveMessage.onFirstCall().returns(Promise.resolve({Messages: [
                {Body: '1'},
                {Body: '2'},
            ]}));
            [1,2,3,4,5,6].forEach(call => {
                sqs.receiveMessage.onCall(call).returns(Promise.resolve({Messages: []}));
            });
            fs.writeFileSync(scriptFile, `
                module.exports = {
                    preProcessMessage(message) {
                        message.Body = String(Number(message.Body) + 10);
                    }
                }
            `);
            const sqsGrep = new SqsGrep(options);
            fs.unlinkSync(scriptFile);
            
            // act
            const res = (await sqsGrep.run())!;

            // assert
            assert.equal(sqs.getQueueUrl.callCount, 2);
            assert.equal(sqs.sendMessage.callCount, 2);
            sinon.assert.calledWith(sqs.sendMessage.firstCall, sinon.match.has('MessageBody', '11'));
            sinon.assert.calledWith(sqs.sendMessage.secondCall, sinon.match.has('MessageBody', '12'));
            assert.equal(sqs.deleteMessage.callCount, 2);
            assert.equal(res.qtyScanned, 2);
            assert.equal(res.qtyMatched, 2);
        });

        it('should call preProcessMatchedMessage user-script hook', async function () {
            // arrange
            const scriptFile = '/tmp/sqs-grep-test-script-2.js';
            const options = parse(['--queue=A', '--all', '--moveTo=B', '--scriptFile', scriptFile]);
            sqs.receiveMessage.onFirstCall().returns(Promise.resolve({Messages: [
                {Body: '1'},
                {Body: '2'},
            ]}));
            [1,2,3,4,5,6].forEach(call => {
                sqs.receiveMessage.onCall(call).returns(Promise.resolve({Messages: []}));
            });
            fs.writeFileSync(scriptFile, `
                module.exports = {
                    async preProcessMessage(message) {
                        message.Body = String(Number(message.Body) + 10);
                    },
                    async preProcessMatchedMessage(message) {
                        message.Body = String(Number(message.Body) + 10);
                    },
                    thisNonFunctionShouldBeIgnored: true
                }
            `);
            const sqsGrep = new SqsGrep(options);
            fs.unlinkSync(scriptFile);
            
            // act
            const res = (await sqsGrep.run())!;

            // assert
            assert.equal(sqs.getQueueUrl.callCount, 2);
            assert.equal(sqs.sendMessage.callCount, 2);
            sinon.assert.calledWith(sqs.sendMessage.firstCall, sinon.match.has('MessageBody', '21'));
            sinon.assert.calledWith(sqs.sendMessage.secondCall, sinon.match.has('MessageBody', '22'));
            assert.equal(sqs.deleteMessage.callCount, 2);
            assert.equal(res.qtyScanned, 2);
            assert.equal(res.qtyMatched, 2);
        });

        it('should expose sqs_grep_require to user-script hooks', async function () {
            // arrange
            const scriptFile = '/tmp/sqs-grep-test-script-3.js';
            const options = parse(['--queue=A', '--all', '--moveTo=B', '--scriptFile', scriptFile]);
            sqs.receiveMessage.onFirstCall().returns(Promise.resolve({Messages: [
                {Body: '1'},
                {Body: '2'},
            ]}));
            [1,2,3,4,5,6].forEach(call => {
                sqs.receiveMessage.onCall(call).returns(Promise.resolve({Messages: []}));
            });
            fs.writeFileSync(scriptFile, `
                const { ungzip } = sqs_grep_require('node-gzip');
                module.exports = {
                    async preProcessMessage(message) {
                        message.Body = ungzip.name;
                    }
                }
            `);
            const sqsGrep = new SqsGrep(options);
            fs.unlinkSync(scriptFile);
            
            // act
            const res = (await sqsGrep.run())!;

            // assert
            assert.equal(sqs.getQueueUrl.callCount, 2);
            assert.equal(sqs.sendMessage.callCount, 2);
            sinon.assert.calledWith(sqs.sendMessage.firstCall, sinon.match.has('MessageBody', 'ungzip'));
            assert.equal(sqs.deleteMessage.callCount, 2);
            assert.equal(res.qtyScanned, 2);
            assert.equal(res.qtyMatched, 2);
        });
    });
    describe('#_unwrapScriptModule()', function () {
        it('should return a CommonJS module.exports object as-is', function () {
            const hooks = {preProcessMessage: () => undefined};
            assert.strictEqual(SqsGrep._unwrapScriptModule(hooks), hooks);
        });
        it('should unwrap the default export of an ES module namespace', function () {
            const hooks = {preProcessMessage: () => undefined};
            const namespace = Object.freeze(Object.assign(Object.create(null), {
                [Symbol.toStringTag]: 'Module',
                default: hooks,
            }));
            assert.strictEqual(SqsGrep._unwrapScriptModule(namespace), hooks);
        });
        it('should unwrap the default export of a transpiled ES module', function () {
            const hooks = {preProcessMessage: () => undefined};
            assert.strictEqual(SqsGrep._unwrapScriptModule({__esModule: true, default: hooks}), hooks);
        });
        it('should keep an ES module namespace without a default export', function () {
            const namespace = {[Symbol.toStringTag]: 'Module', preProcessMessage: () => undefined};
            assert.strictEqual(SqsGrep._unwrapScriptModule(namespace), namespace);
        });
        [null, undefined, 42, 'text'].forEach(value => {
            it(`should treat the non-object export ${String(value)} as no hooks`, function () {
                assert.deepEqual(SqsGrep._unwrapScriptModule(value), {});
            });
        });
    });
    describe('user scripts written as ES modules', function () {
        it('should load hooks from an .mjs script with a default export', async function () {
            // arrange
            const scriptFile = path.join(os.tmpdir(), `sqs-grep-test-script-${process.pid}.mjs`);
            const options = parse(['--queue=A', '--all', '--moveTo=B', '--scriptFile', scriptFile]);
            sqs.receiveMessage.onFirstCall().returns(Promise.resolve({Messages: [{Body: 'esm'}]}));
            [1,2,3,4,5,6].forEach(call => {
                sqs.receiveMessage.onCall(call).returns(Promise.resolve({Messages: []}));
            });
            fs.writeFileSync(scriptFile, `
                const { ungzip } = sqs_grep_require('node-gzip');
                export default {
                    async preProcessMessage(message) {
                        this.log('from an ES module script');
                        message.Body = message.Body + '-' + ungzip.name;
                    }
                };
            `);
            try {
                const sqsGrep = new SqsGrep(options);

                // act
                const res = (await sqsGrep.run())!;

                // assert
                sinon.assert.calledWith(sqs.sendMessage.firstCall, sinon.match.has('MessageBody', 'esm-ungzip'));
                sinon.assert.calledWith(emptyLog, 'from an ES module script');
                assert.equal(res.qtyMatched, 1);
            } finally {
                fs.unlinkSync(scriptFile);
            }
        });
    });
    describe('--stateFile', function () {
        let tempDir: string, stateFilePath: string, inputFilePath: string;
        const readState = (): {lastProcessedIndex: number; inputFile: string} => JSON.parse(fs.readFileSync(stateFilePath, 'utf-8'));
        const writeInputFile = (qty: number): void => {
            const lines = [];
            for (let i = 1; i <= qty; i++) {
                lines.push(JSON.stringify({Body: `msg${i}`, MessageId: `id${i}`}));
            }
            fs.writeFileSync(inputFilePath, lines.join('\n'), 'utf-8');
        };
        const stateArgs = (extra: string[] = []): string[] => [
            `--inputFile=${inputFilePath}`,
            '--all',
            `--stateFile=${stateFilePath}`,
            ...extra,
        ];

        beforeEach(function () {
            tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqs-grep-run-state-'));
            stateFilePath = path.join(tempDir, 'state.json');
            inputFilePath = path.join(tempDir, 'queue.jsonl');
        });
        afterEach(function () {
            fs.rmSync(tempDir, {recursive: true, force: true});
        });

        it('should not track state when --stateFile is not set', async function () {
            // arrange
            writeInputFile(3);
            const sqsGrep = new SqsGrep(parse([`--inputFile=${inputFilePath}`, '--all']));

            // act
            const res = (await sqsGrep.run())!;

            // assert
            assert.equal(res.qtyScanned, 3);
            assert.equal(sqsGrep.stateFile, null);
            assert.equal(fs.existsSync(stateFilePath), false);
        });

        it('should save the state after a full scan', async function () {
            // arrange
            writeInputFile(3);
            const sqsGrep = new SqsGrep(parse(stateArgs()));

            // act
            const res = (await sqsGrep.run())!;

            // assert
            assert.equal(res.qtyScanned, 3);
            assert.equal(res.qtyMatched, 3);
            assert.equal(readState().lastProcessedIndex, 3);
            assert.equal(readState().inputFile, inputFilePath);
        });

        it('should resume from the message after the last one processed', async function () {
            // arrange
            writeInputFile(10);
            fs.writeFileSync(stateFilePath, JSON.stringify({inputFile: inputFilePath, lastProcessedIndex: 7}));
            const sqsGrep = new SqsGrep(parse(stateArgs(['--copyTo=B'])));

            // act
            const res = (await sqsGrep.run())!;

            // assert
            assert.equal(res.qtyScanned, 3, 'Should only scan messages 8, 9 and 10');
            assert.equal(sqs.sendMessage.callCount, 3);
            sinon.assert.calledWith(sqs.sendMessage.firstCall, sinon.match.has('MessageBody', 'msg8'));
            sinon.assert.calledWith(sqs.sendMessage.secondCall, sinon.match.has('MessageBody', 'msg9'));
            sinon.assert.calledWith(sqs.sendMessage.thirdCall, sinon.match.has('MessageBody', 'msg10'));
            assert.equal(readState().lastProcessedIndex, 10);
        });

        it('should process nothing when the whole file was already processed', async function () {
            // arrange
            writeInputFile(4);
            fs.writeFileSync(stateFilePath, JSON.stringify({inputFile: inputFilePath, lastProcessedIndex: 4}));
            const sqsGrep = new SqsGrep(parse(stateArgs(['--copyTo=B'])));

            // act
            const res = (await sqsGrep.run())!;

            // assert
            assert.equal(res.qtyScanned, 0);
            assert.equal(res.qtyMatched, 0);
            assert.equal(sqs.sendMessage.callCount, 0);
            assert.equal(readState().lastProcessedIndex, 4, 'Should keep the previous state untouched');
        });

        it('should warn when the state file is ahead of the input file', async function () {
            // arrange
            writeInputFile(2);
            fs.writeFileSync(stateFilePath, JSON.stringify({inputFile: inputFilePath, lastProcessedIndex: 5}));
            const logs: string[] = [];
            const options = parse(stateArgs());
            options.log = (msg: unknown) => { logs.push(String(msg)) };
            const sqsGrep = new SqsGrep(options);

            // act
            const res = (await sqsGrep.run())!;

            // assert
            assert.equal(res.qtyScanned, 0);
            assert.equal(/only contains 2 message\(s\), but the state file says that 5/.test(logs.join('\n')), true);
        });

        it('should start over when the state file refers to another input file', async function () {
            // arrange
            writeInputFile(3);
            fs.writeFileSync(stateFilePath, JSON.stringify({
                inputFile: path.join(tempDir, 'another.jsonl'),
                lastProcessedIndex: 2,
            }));
            const sqsGrep = new SqsGrep(parse(stateArgs()));

            // act
            const res = (await sqsGrep.run())!;

            // assert
            assert.equal(res.qtyScanned, 3, 'Should scan the whole file again');
            assert.equal(readState().lastProcessedIndex, 3);
        });

        it('should start over when the state file is corrupt', async function () {
            // arrange
            writeInputFile(3);
            fs.writeFileSync(stateFilePath, 'corrupt-state');
            const sqsGrep = new SqsGrep(parse(stateArgs()));

            // act
            const res = (await sqsGrep.run())!;

            // assert
            assert.equal(res.qtyScanned, 3);
            assert.equal(readState().lastProcessedIndex, 3);
        });

        it('should track unmatched messages as processed', async function () {
            // arrange
            writeInputFile(5);
            const sqsGrep = new SqsGrep(parse([
                `--inputFile=${inputFilePath}`,
                '--body=msg2',
                `--stateFile=${stateFilePath}`,
            ]));

            // act
            const res = (await sqsGrep.run())!;

            // assert
            assert.equal(res.qtyScanned, 5);
            assert.equal(res.qtyMatched, 1);
            assert.equal(readState().lastProcessedIndex, 5, 'Unmatched messages must not be scanned again');
        });

        it('should save periodically based on --stateFileInterval', async function () {
            // arrange
            writeInputFile(10);
            const sqsGrep = new SqsGrep(parse(stateArgs(['--stateFileInterval=2'])));
            const saved: number[] = [];
            const originalRename = fs.renameSync;
            sinon.replace(fs, 'renameSync', (from, to) => {
                saved.push((JSON.parse(fs.readFileSync(from, 'utf-8')) as {lastProcessedIndex: number}).lastProcessedIndex);
                return originalRename(from, to);
            });

            // act
            const res = (await sqsGrep.run())!;

            // assert
            assert.equal(res.qtyScanned, 10);
            assert.deepEqual(saved, [2, 4, 6, 8, 10], 'Should save every 2 messages');
        });

        it('should not save on every single message by default', async function () {
            // arrange
            writeInputFile(10);
            const sqsGrep = new SqsGrep(parse(stateArgs()));
            const renameSync = sinon.spy(fs, 'renameSync');

            // act
            await sqsGrep.run();

            // assert
            assert.equal(renameSync.callCount, 1, 'Should only save once, at the end of the execution');
            assert.equal(readState().lastProcessedIndex, 10);
        });

        it('should save the state when interrupted', async function () {
            // arrange
            writeInputFile(10);
            const options = parse(stateArgs(['--stateFileInterval=1000']));
            const sqsGrep = new SqsGrep(options);
            const scriptHook = sqsGrep.userScript.preProcessMessage;
            sqsGrep.userScript.preProcessMessage = async (message: SqsGrepMessage) => {
                await scriptHook(message);
                if (message.Body === 'msg4') {
                    sqsGrep.interrupt();
                }
            };

            // act
            const res = (await sqsGrep.run())!;

            // assert
            assert.equal(res.qtyScanned, 4);
            assert.equal(sqsGrep.running, false);
            assert.equal(readState().lastProcessedIndex, 4, 'Should save progress on interrupt');
        });

        it('should resume after an interruption', async function () {
            // arrange
            writeInputFile(6);
            const interruptingRun = new SqsGrep(parse(stateArgs(['--copyTo=B', '--stateFileInterval=1000'])));
            const scriptHook = interruptingRun.userScript.preProcessMessage;
            interruptingRun.userScript.preProcessMessage = async (message: SqsGrepMessage) => {
                await scriptHook(message);
                if (message.Body === 'msg3') {
                    interruptingRun.interrupt();
                }
            };

            // act
            const firstRes = (await interruptingRun.run())!;
            const resumedRun = new SqsGrep(parse(stateArgs(['--copyTo=B'])));
            const secondRes = (await resumedRun.run())!;

            // assert
            assert.equal(firstRes.qtyScanned, 3);
            assert.equal(secondRes.qtyScanned, 3, 'Should scan the remaining 3 messages');
            assert.equal(readState().lastProcessedIndex, 6);
            // Each message must have been copied exactly once, in order
            assert.equal(sqs.sendMessage.callCount, 6);
            const bodies = sqs.sendMessage.getCalls().map((call: sinon.SinonSpyCall) => call.args[0].MessageBody);
            assert.deepEqual(bodies, ['msg1', 'msg2', 'msg3', 'msg4', 'msg5', 'msg6']);
        });

        it('should save the state when the execution fails', async function () {
            // arrange
            writeInputFile(10);
            sqs.sendMessage.onCall(0).returns(Promise.resolve({}));
            sqs.sendMessage.onCall(1).returns(Promise.resolve({}));
            sqs.sendMessage.onCall(2).returns(Promise.reject(new Error('Fake error')));
            const sqsGrep = new SqsGrep(parse(stateArgs(['--copyTo=B', '--stateFileInterval=1000'])));

            // act, assert
            await assert.rejects(() => sqsGrep.run(), (err: Error) => err.message === 'Fake error');
            assert.equal(readState().lastProcessedIndex, 2, 'Should save the messages processed before the failure');
        });

        it('should not resume past a message which is still in flight', async function () {
            // arrange
            writeInputFile(4);
            const options = parse(stateArgs(['--copyTo=B', '--parallel=2', '--stateFileInterval=1000']));
            const sqsGrep = new SqsGrep(options);
            // The copy of the first message never completes until we release it,
            // while the remaining messages are processed by the second poller
            let releaseFirstMessage: (() => void) | undefined;
            let lastMessageProcessed: (() => void) | undefined;
            const lastMessageDone = new Promise<void>(resolve => { lastMessageProcessed = resolve });
            sqs.sendMessage.callsFake((params: {MessageBody: string}) => {
                if (params.MessageBody === 'msg1') {
                    return new Promise(resolve => { releaseFirstMessage = () => resolve({}) });
                }
                if (params.MessageBody === 'msg4') {
                    setImmediate(lastMessageProcessed!);
                }
                return Promise.resolve({});
            });

            // act
            const runPromise = sqsGrep.run();
            await lastMessageDone;
            await new Promise(resolve => setImmediate(resolve));
            const inFlightIndex = sqsGrep.stateFile!.lastProcessedIndex;
            const inFlightPending = [...sqsGrep.stateFile!.pendingIndexes].sort((a, b) => a - b);
            releaseFirstMessage!();
            const res = (await runPromise)!;

            // assert
            assert.equal(inFlightIndex, 0, 'Must not skip a message which is still in flight');
            assert.deepEqual(inFlightPending, [2, 3, 4], 'Later messages must wait for message 1');
            assert.equal(res.qtyScanned, 4);
            assert.equal(readState().lastProcessedIndex, 4, 'Should advance once message 1 completes');
        });

        it('should stop at --maxMessages and resume from the next message', async function () {
            // arrange
            writeInputFile(10);
            const firstRun = new SqsGrep(parse(stateArgs(['--copyTo=B', '--maxMessages=4'])));

            // act
            const firstRes = (await firstRun.run())!;
            const secondRun = new SqsGrep(parse(stateArgs(['--copyTo=B', '--maxMessages=4'])));
            const secondRes = (await secondRun.run())!;

            // assert
            assert.equal(firstRes.qtyMatched, 4);
            assert.equal(secondRes.qtyMatched, 4);
            assert.equal(readState().lastProcessedIndex, 8);
            const bodies = sqs.sendMessage.getCalls().map((call: sinon.SinonSpyCall) => call.args[0].MessageBody);
            assert.deepEqual(bodies, ['msg1', 'msg2', 'msg3', 'msg4', 'msg5', 'msg6', 'msg7', 'msg8']);
        });

        it('should not create a state file when no message is processed', async function () {
            // arrange
            fs.writeFileSync(inputFilePath, '', 'utf-8');
            const sqsGrep = new SqsGrep(parse(stateArgs()));

            // act
            const res = (await sqsGrep.run())!;

            // assert
            assert.equal(res.qtyScanned, 0);
            assert.equal(fs.existsSync(stateFilePath), false);
        });

        it('should log the saved progress', async function () {
            // arrange
            writeInputFile(2);
            const logs: string[] = [];
            const options = parse(stateArgs());
            options.log = (msg: unknown) => { logs.push(String(msg)) };
            const sqsGrep = new SqsGrep(options);

            // act
            await sqsGrep.run();

            // assert
            assert.equal(/Progress saved to .*state\.json.*\(last processed message: .*2/.test(logs.join('\n')), true);
        });

        it('should log the saved progress when the last message lands on a periodic save', async function () {
            // arrange: --maxMessages exactly on a --stateFileInterval boundary, so the
            // final save is a no-op because the periodic save already persisted everything
            writeInputFile(10);
            const logs: string[] = [];
            const options = parse(stateArgs(['--stateFileInterval=4', '--maxMessages=4']));
            options.log = (msg: unknown) => { logs.push(String(msg)) };
            const sqsGrep = new SqsGrep(options);

            // act
            const res = (await sqsGrep.run())!;

            // assert
            assert.equal(res.qtyMatched, 4);
            assert.equal(readState().lastProcessedIndex, 4);
            assert.equal(/Progress saved to .*state\.json.*\(last processed message: .*4/.test(logs.join('\n')), true,
                'Should report the resume point even when nothing new was written');
        });

        it('should log the saved progress only once when interrupted', async function () {
            // arrange
            writeInputFile(10);
            const logs: string[] = [];
            const options = parse(stateArgs(['--stateFileInterval=1']));
            options.log = (msg: unknown) => { logs.push(String(msg)) };
            const sqsGrep = new SqsGrep(options);
            const scriptHook = sqsGrep.userScript.preProcessMessage;
            sqsGrep.userScript.preProcessMessage = async (message: SqsGrepMessage) => {
                await scriptHook(message);
                if (message.Body === 'msg3') {
                    sqsGrep.interrupt();
                }
            };

            // act
            await sqsGrep.run();

            // assert
            const saveLogs = logs.filter(msg => /Progress saved to/.test(msg));
            assert.equal(saveLogs.length, 1, 'The resume point must be logged exactly once');
            assert.equal(/last processed message: .*3/.test(saveLogs[0]), true);
        });

        it('should not log any progress when no message is processed', async function () {
            // arrange
            fs.writeFileSync(inputFilePath, '', 'utf-8');
            const logs: string[] = [];
            const options = parse(stateArgs());
            options.log = (msg: unknown) => { logs.push(String(msg)) };
            const sqsGrep = new SqsGrep(options);

            // act
            await sqsGrep.run();

            // assert
            assert.equal(/Progress saved to/.test(logs.join('\n')), false);
        });

        it('should track the index without polluting the message object', async function () {
            // arrange
            writeInputFile(2);
            const sqsGrep = new SqsGrep(parse(stateArgs(['--copyTo=B'])));
            const seen: {keys: string[]; index: number | undefined}[] = [];
            sqsGrep.userScript.preProcessMessage = (message: SqsGrepMessage) => {
                seen.push({keys: Object.keys(message), index: message[MESSAGE_INDEX]});
            };

            // act
            await sqsGrep.run();

            // assert
            assert.deepEqual(seen.map(m => m.index), [1, 2], 'Messages must be indexed in file order');
            seen.forEach(m => assert.deepEqual(m.keys, ['Body', 'MessageId'],
                'The index must not become an enumerable message property'));
            // The index lives in a Symbol, so it is never serialized to SQS/SNS or files
            const sent = sqs.sendMessage.getCalls().map((call: sinon.SinonSpyCall) => call.args[0].MessageBody);
            assert.deepEqual(sent, ['msg1', 'msg2']);
        });
    });
});

