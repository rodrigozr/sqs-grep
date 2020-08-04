/* eslint-disable no-undef */
const assert = require('assert');
const sinon = require('sinon');
const fs = require('fs');
const AWS = require('aws-sdk');
const {parseOptions} = require('../src/options');
const {SqsGrep} = require('../src/sqs-grep');

const emptyLog = sinon.stub();

describe('SqsGrep', function () {
    let sqs, sns;
    const parse = args => ({
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
        sqs.getQueueUrl.returns({
            promise: () => Promise.resolve({QueueUrl: 'fake://url'})
        });
        sqs.getQueueAttributes.returns({
            promise: () => Promise.resolve({Attributes: {ApproximateNumberOfMessages: 0}})
        });
        sqs.sendMessage.returns({
            promise: () => Promise.resolve({})
        });
        sqs.deleteMessage.returns({
            promise: () => Promise.resolve({})
        });
        sns = {
            getTopicAttributes: sinon.stub(),
            publish: sinon.stub(),
        };
        sns.getTopicAttributes.returns({
            promise: () => Promise.resolve({})
        });
        sns.publish.returns({
            promise: () => Promise.resolve({})
        });
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
        it('should default sqs to AWS.SQS', async function () {
            const options = parse(['--help']);
            delete options.sqs;
            const sqsGrep = new SqsGrep(options);
            assert.equal(sqsGrep.sqs instanceof AWS.SQS, true);
        });
        it('should default sns to AWS.SNS', async function () {
            const options = parse(['--help']);
            delete options.sns;
            const sqsGrep = new SqsGrep(options);
            assert.equal(sqsGrep.sns instanceof AWS.SNS, true);
        });
        it('should default all parameters', async function () {
            const sqsGrep = new SqsGrep({});
            assert.equal(sqsGrep.sqs instanceof AWS.SQS, true);
            assert.equal(sqsGrep.log, console.log);
            assert.equal(sqsGrep.options.parallel, 1);
        });
        it('should override default parameters', async function () {
            const sqsGrep = new SqsGrep({parallel: 2});
            assert.equal(sqsGrep.sqs instanceof AWS.SQS, true);
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
        it('should set the accessKeyId', async function () {
            const options = parse(['--accessKeyId', 'KEY_ID']);
            const opts = SqsGrep._getAwsOptions(options);
            assert.equal(opts.accessKeyId, 'KEY_ID');
        });
        it('should set the secretAccessKey', async function () {
            const options = parse(['--secretAccessKey', 'SECRET']);
            const opts = SqsGrep._getAwsOptions(options);
            assert.equal(opts.secretAccessKey, 'SECRET');
        });
        it('should set the endpointUrl', async function () {
            const options = parse(['--endpointUrl', 'http://localhost:5000']);
            const opts = SqsGrep._getAwsOptions(options);
            assert.equal(opts.endpoint.protocol, 'http:');
            assert.equal(opts.endpoint.hostname, 'localhost');
            assert.equal(opts.endpoint.port, 5000);
            assert.equal(opts.endpoint.path, '/');
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
            sqs.receiveMessage.onFirstCall().returns({
                promise: () => Promise.resolve({Messages: [
                    {Body: '1'},
                    {Body: '2'},
                ]})
            });
            sqs.receiveMessage.onSecondCall().returns({
                promise: () => Promise.resolve({Messages: [
                    {Body: '3'},
                ]})
            });
            [2,3,4,5,6].forEach(call => {
                sqs.receiveMessage.onCall(call).returns({
                    promise: () => Promise.resolve({Messages: []})
                });
            });
            
            // act
            const res = await sqsGrep.run();

            // assert
            assert.equal(res.qtyScanned, 3);
            assert.equal(res.qtyMatched, 3);
        });

        it('should scan all messages with intermittent empty receives', async function () {
            // arrange
            const options = parse(['--queue=A', '--all']);
            const sqsGrep = new SqsGrep(options);
            sqs.receiveMessage.onFirstCall().returns({
                promise: () => Promise.resolve({Messages: [
                    {Body: '1'},
                ]})
            });
            [1,2,3,4].forEach(call => {
                sqs.receiveMessage.onCall(call).returns({
                    promise: () => Promise.resolve({Messages: []})
                });
            });
            sqs.receiveMessage.onCall(5).returns({
                promise: () => Promise.resolve({Messages: [
                    {Body: '2'},
                ]})
            });
            [6,7,8,9].forEach(call => {
                sqs.receiveMessage.onCall(call).returns({
                    promise: () => Promise.resolve({Messages: []})
                });
            });
            sqs.receiveMessage.onCall(10).returns({
                promise: () => Promise.resolve({Messages: [
                    {Body: '3'},
                ]})
            });
            [11,12,13,14,15].forEach(call => {
                sqs.receiveMessage.onCall(call).returns({
                    promise: () => Promise.resolve({Messages: []})
                });
            });
            
            // act
            const res = await sqsGrep.run();

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
                sqs.receiveMessage.onCall(call).returns({
                    promise: () => Promise.resolve({Messages: []})
                });
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
            const res = await resPromise;

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
            sqs.receiveMessage.onFirstCall().returns({
                promise: () => Promise.resolve({Messages: [
                    {Body: '1'},
                    {Body: '2'},
                ]})
            });
            sqs.receiveMessage.onSecondCall().returns({
                promise: () => Promise.resolve({Messages: [
                    {Body: '3'},
                ]})
            });
            [2,3,4,5,6].forEach(call => {
                sqs.receiveMessage.onCall(call).returns({
                    promise: () => Promise.resolve({Messages: []})
                });
            });
            
            // act
            const res = await sqsGrep.run();

            // assert
            assert.equal(res.qtyScanned, 3);
            assert.equal(res.qtyMatched, 1);
        });

        it('should filter messages by attributes', async function () {
            // arrange
            const options = parse(['--queue=A', '--attribute=key=val', '--silent']);
            const sqsGrep = new SqsGrep(options);
            sqs.receiveMessage.onFirstCall().returns({
                promise: () => Promise.resolve({Messages: [
                    {Body: '1', MessageAttributes:{key: {StringValue: 'val'}}},
                    {Body: '2', MessageAttributes:{key: {StringValue: 'nop'}}},
                ]})
            });
            sqs.receiveMessage.onSecondCall().returns({
                promise: () => Promise.resolve({Messages: [
                    {Body: '3', MessageAttributes:{key: {StringValue: 'val'}}},
                ]})
            });
            [2,3,4,5,6].forEach(call => {
                sqs.receiveMessage.onCall(call).returns({
                    promise: () => Promise.resolve({Messages: []})
                });
            });
            
            // act
            const res = await sqsGrep.run();

            // assert
            assert.equal(res.qtyScanned, 3);
            assert.equal(res.qtyMatched, 2);
        });

        it('should filter negated messages', async function () {
            // arrange
            const options = parse(['--queue=A', '--body=2', '--negate', '--full']);
            const sqsGrep = new SqsGrep(options);
            sqs.receiveMessage.onFirstCall().returns({
                promise: () => Promise.resolve({Messages: [
                    {Body: '1'},
                    {Body: '2'},
                ]})
            });
            sqs.receiveMessage.onSecondCall().returns({
                promise: () => Promise.resolve({Messages: [
                    {Body: '3'},
                ]})
            });
            [2,3,4,5,6].forEach(call => {
                sqs.receiveMessage.onCall(call).returns({
                    promise: () => Promise.resolve({Messages: []})
                });
            });
            
            // act
            const res = await sqsGrep.run();

            // assert
            assert.equal(res.qtyScanned, 3);
            assert.equal(res.qtyMatched, 2);
        });

        it('should raise downstream errors', async function () {
            // arrange
            const options = parse(['--queue=A', '--all']);
            const sqsGrep = new SqsGrep(options);
            sqs.receiveMessage.onFirstCall().returns({
                promise: () => Promise.resolve({Messages: [
                    {Body: '1'},
                    {Body: '2'},
                ]})
            });
            sqs.receiveMessage.onSecondCall().returns({
                promise: () => Promise.reject(new Error('Fake error'))
            });
            
            // act, assert
            assert.rejects(sqsGrep.run(), new Error('Fake error'));
            assert.equal(sqsGrep.running, false);
        });

        it('should stop when interrupted after receive', async function () {
            // arrange
            const options = parse(['--queue=A', '--all']);
            const sqsGrep = new SqsGrep(options);
            sqs.receiveMessage.onFirstCall().returns({
                promise: () => Promise.resolve({Messages: [
                    {Body: '1'},
                    {Body: '2'},
                ]})
            });
            sqs.receiveMessage.onSecondCall().callsFake(() => {
                sqsGrep.interrupt();
                return {
                    promise: () => Promise.resolve({Messages: [
                        {Body: '3'},
                    ]})
                };
            });
                        
            // act
            const res = await sqsGrep.run();

            // assert
            assert.equal(res.qtyScanned, 3);
            assert.equal(res.qtyMatched, 2);
            assert.equal(sqsGrep.running, false);
        });

        it('should stop when interrupted during message processing', async function () {
            // arrange
            const options = parse(['--queue=A', '--all']);
            const sqsGrep = new SqsGrep(options);
            sqs.receiveMessage.onFirstCall().returns({
                promise: () => Promise.resolve({Messages: [
                    {Body: '1'},
                    {Body: '2'},
                ]})
            });
            sqs.receiveMessage.onSecondCall().returns({
                promise: () => Promise.resolve({Messages: [
                    {Body: '3'},
                ]})
            });
            const originalProcess = sqsGrep._processMatchedSqsMessage;
            sinon.stub(sqsGrep, '_processMatchedSqsMessage').callsFake(function() {
                this.interrupt();
                originalProcess.apply(this, arguments);
            });
                        
            // act
            const res = await sqsGrep.run();

            // assert
            assert.equal(res.qtyScanned, 2);
            assert.equal(res.qtyMatched, 1);
            assert.equal(sqsGrep.running, false);
        });

        it('should stop when maxMessages is reached', async function () {
            // arrange
            const options = parse(['--queue=A', '--all', '--maxMessages=3']);
            const sqsGrep = new SqsGrep(options);
            sqs.receiveMessage.onFirstCall().returns({
                promise: () => Promise.resolve({Messages: [
                    {Body: '1'},
                    {Body: '2'},
                    {Body: '3'},
                    {Body: '4'},
                    {Body: '5'},
                ]})
            });
            
            // act
            const res = await sqsGrep.run();

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
                    return {
                        promise: () => Promise.resolve({Messages: [
                            {Body: 'Message ' + messageNumber},
                        ]})
                    };
                });
            });
            
            // act
            const res = await sqsGrep.run();

            // assert
            assert.equal(res.qtyScanned, 8);
            assert.equal(res.qtyMatched, 7);
        });

        it('should copy messages', async function () {
            // arrange
            const options = parse(['--queue=A', '--all', '--copyTo=B']);
            const sqsGrep = new SqsGrep(options);
            sqs.receiveMessage.onFirstCall().returns({
                promise: () => Promise.resolve({Messages: [
                    {Body: '1', MessageAttributes:{key: {StringValue: 'val'}}},
                    {Body: '2'},
                ]})
            });
            [1,2,3,4,5,6].forEach(call => {
                sqs.receiveMessage.onCall(call).returns({
                    promise: () => Promise.resolve({Messages: []})
                });
            });
            
            // act
            const res = await sqsGrep.run();

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
            sqs.receiveMessage.onFirstCall().returns({
                promise: () => Promise.resolve({Messages: [
                    {Body: '1', MessageAttributes:{key: {StringValue: 'val'}}},
                    {Body: '2'},
                ]})
            });
            [1,2,3,4,5,6].forEach(call => {
                sqs.receiveMessage.onCall(call).returns({
                    promise: () => Promise.resolve({Messages: []})
                });
            });
            
            // act
            const res = await sqsGrep.run();

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
            sqs.receiveMessage.onFirstCall().returns({
                promise: () => Promise.resolve({Messages: [
                    {Body: '1', MessageAttributes:{key: {StringValue: 'val'}}},
                    {Body: '2', MessageAttributes:{key: {StringValue: 'val'}}},
                ]})
            });
            [1,2,3,4,5,6].forEach(call => {
                sqs.receiveMessage.onCall(call).returns({
                    promise: () => Promise.resolve({Messages: []})
                });
            });
            
            // act
            const res = await sqsGrep.run();

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
            sqs.receiveMessage.onFirstCall().returns({
                promise: () => Promise.resolve({Messages: [
                    {Body: '1', MessageAttributes:{key: {StringValue: 'val'}}, Attributes:{}, MessageId: 'id'},
                    {Body: '2', MessageAttributes:{key: {StringValue: 'val'}}, Attributes:{MessageGroupId:'group', MessageDeduplicationId: 'dup'}},
                ]})
            });
            [1,2,3,4,5,6].forEach(call => {
                sqs.receiveMessage.onCall(call).returns({
                    promise: () => Promise.resolve({Messages: []})
                });
            });
            sqs.getQueueUrl.withArgs({QueueName:'B.fifo'}).returns({
                promise: () => Promise.resolve({QueueUrl: 'fake://B.fifo'})
            });
                
            // act
            const res = await sqsGrep.run();

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
            sqs.receiveMessage.onFirstCall().returns({
                promise: () => Promise.resolve({Messages: [
                    {Body: '1', MessageAttributes:{key: {StringValue: 'val'}}},
                    {Body: '2'},
                ]})
            });
            [1,2,3,4,5,6].forEach(call => {
                sqs.receiveMessage.onCall(call).returns({
                    promise: () => Promise.resolve({Messages: []})
                });
            });
            
            // act
            const res = await sqsGrep.run();

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

        it('should publish SNS notification without re-wrapping them', async function () {
            // arrange
            const options = parse(['--queue=A', '--all', '--publishTo=FAKE_ARN']);
            const sqsGrep = new SqsGrep(options);
            sqs.receiveMessage.onFirstCall().returns({
                promise: () => Promise.resolve({Messages: [
                    {Body: '{"Type":"Notification","Message":"1"}'},
                    {Body: '2'},
                ]})
            });
            [1,2,3,4,5,6].forEach(call => {
                sqs.receiveMessage.onCall(call).returns({
                    promise: () => Promise.resolve({Messages: []})
                });
            });
            
            // act
            const res = await sqsGrep.run();

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

        it('should publish messages stripping attributes', async function () {
            // arrange
            const options = parse(['--queue=A', '--all', '--publishTo=FAKE_ARN', '--stripAttributes']);
            const sqsGrep = new SqsGrep(options);
            sqs.receiveMessage.onFirstCall().returns({
                promise: () => Promise.resolve({Messages: [
                    {Body: '1', MessageAttributes:{key: {StringValue: 'val'}}},
                    {Body: '2'},
                ]})
            });
            [1,2,3,4,5,6].forEach(call => {
                sqs.receiveMessage.onCall(call).returns({
                    promise: () => Promise.resolve({Messages: []})
                });
            });
            
            // act
            const res = await sqsGrep.run();

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
            sqs.receiveMessage.onFirstCall().returns({
                promise: () => Promise.resolve({Messages: [
                        {Body: '{"Type":"Notification","Message":"1", "TopicArn":"A"}'},
                        {Body: '{"Type":"Notification","Message":"2", "TopicArn":"B"}'},
                    ]})
            });
            [1,2,3,4,5,6].forEach(call => {
                sqs.receiveMessage.onCall(call).returns({
                    promise: () => Promise.resolve({Messages: []})
                });
            });

            // act
            const res = await sqsGrep.run();

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

        it('should republish SNS messages stripping attributes', async function () {
            // arrange
            const options = parse(['--queue=A', '--all', '--republish', '--stripAttributes']);
            const sqsGrep = new SqsGrep(options);
            sqs.receiveMessage.onFirstCall().returns({
                promise: () => Promise.resolve({Messages: [
                        {Body: '{"Type":"Notification","Message":"1", "TopicArn":"A"}', MessageAttributes:{key: {StringValue: 'val'}}},
                        {Body: '{"Type":"Notification","Message":"2", "TopicArn":"B"}'},
                    ]})
            });
            [1,2,3,4,5,6].forEach(call => {
                sqs.receiveMessage.onCall(call).returns({
                    promise: () => Promise.resolve({Messages: []})
                });
            });

            // act
            const res = await sqsGrep.run();

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
            sqs.receiveMessage.onFirstCall().returns({
                promise: () => Promise.resolve({
                    Messages: [
                        {Body: 'ABCD'}, // Non-JSON
                        {Body: '{"Type":"ABCD","Message":"1", "TopicArn":"A"}'}, // Type not Notification
                        {Body: '{"Type":"Notification", "TopicArn":"A"}'}, // No Message attribute
                        {Body: '{"Type":"Notification","Message":"1"}'} // No Topic Arn attribute
                    ]
                })
            });
            [1,2,3,4,5,6].forEach(call => {
                sqs.receiveMessage.onCall(call).returns({
                    promise: () => Promise.resolve({Messages: []})
                });
            });

            // act
            const res = await sqsGrep.run();

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
            sqs.receiveMessage.onFirstCall().returns({
                promise: () => Promise.resolve({Messages: [
                    {Body: '1'},
                    {Body: '2'},
                ]})
            });
            [1,2,3,4,5,6].forEach(call => {
                sqs.receiveMessage.onCall(call).returns({
                    promise: () => Promise.resolve({Messages: []})
                });
            });
            
            // act
            const res = await sqsGrep.run();

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
            sqs.receiveMessage.onFirstCall().returns({
                promise: () => Promise.resolve({Messages: [
                    {Body: '1'},
                    {Body: '2'},
                ]})
            });
            [1,2,3,4,5,6].forEach(call => {
                sqs.receiveMessage.onCall(call).returns({
                    promise: () => Promise.resolve({Messages: []})
                });
            });
            
            // act
            const res = await sqsGrep.run();

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
            sqs.listDeadLetterSourceQueues.onFirstCall().returns({
                promise: () => Promise.resolve({queueUrls: [
                    'fake://queueA'
                ]})
            });
            sqs.receiveMessage.onFirstCall().returns({
                promise: () => Promise.resolve({Messages: [
                    {Body: '1'},
                    {Body: '2'},
                ]})
            });
            [1,2,3,4,5,6].forEach(call => {
                sqs.receiveMessage.onCall(call).returns({
                    promise: () => Promise.resolve({Messages: []})
                });
            });
            
            // act
            const res = await sqsGrep.run();

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
            sqs.listDeadLetterSourceQueues.onFirstCall().returns({
                promise: () => Promise.resolve({})
            });
            
            // act, assert
            await assert.rejects(() => sqsGrep.run(),
                err => err.message.includes('ERROR - Could not find source queue for dead-letter'));
        });

        it('should fail redrive with multiple source queues', async function () {
            // arrange
            const options = parse(['--queue=A', '--all', '--redrive']);
            const sqsGrep = new SqsGrep(options);
            sqs.listDeadLetterSourceQueues.onFirstCall().returns({
                promise: () => Promise.resolve({queueUrls: [
                    'fake://queueB',
                    'fake://queueC',
                    'fake://queueD',
                ]})
            });
            
            // act, assert
            await assert.rejects(() => sqsGrep.run(),
                err => err.message.includes('ERROR - Found a total of 3 source queues for dead-letter'));
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
            sqs.receiveMessage.onFirstCall().returns({
                promise: () => Promise.resolve({Messages: [
                    {Body: '1'},
                    {Body: '2'},
                ]})
            });
            sqs.receiveMessage.onSecondCall().returns({
                promise: () => Promise.resolve({Messages: [
                    {Body: '3'},
                ]})
            });
            [2,3,4,5,6].forEach(call => {
                sqs.receiveMessage.onCall(call).returns({
                    promise: () => Promise.resolve({Messages: []})
                });
            });
            
            // act
            const res = await sqsGrep.run();

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
            const res = await sqsGrep.run();

            // assert
            assert.equal(res.qtyScanned, 2);
            assert.equal(res.qtyMatched, 1);
            fs.unlinkSync('.input');
        });

        it('should raise downstream errors writing to file system', async function () {
            // arrange
            const options = parse(['--queue=A', '--all', '--outputFile=.out']);
            const sqsGrep = new SqsGrep(options);
            sqs.receiveMessage.onFirstCall().returns({
                promise: () => Promise.resolve({Messages: [
                    {Body: '1'},
                    {Body: '2'},
                ]})
            });
            sinon.replace(fs, 'appendFile', (file, content, encoding, callback) => {
                callback(new Error('Fake error'));
            });
            
            // act, assert
            assert.rejects(sqsGrep.run(), new Error('Fake error'));
            assert.equal(sqsGrep.running, false);
        });

        it('should log AWS calls when --verbose is set (custom log)', async function () {
            // arrange
            const options = parse(['--queue=A', '--all', '--verbose']);
            function log() { }
            options.log = log;

            // act
            const awsOptions = SqsGrep._getAwsOptions(options);

            // assert
            assert(awsOptions.logger.log === log);
        });

        it('should log AWS calls when --verbose is set', async function () {
            // arrange
            const options = parse(['--queue=A', '--all', '--verbose']);
            options.log = undefined;

            // act
            const awsOptions = SqsGrep._getAwsOptions(options);

            // assert
            assert(awsOptions.logger.log === console.log);
        });
    });
});
