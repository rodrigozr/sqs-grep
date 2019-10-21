const assert = require('assert');
const sinon = require('sinon');
const fs = require('fs');
const AWS = require('aws-sdk');
const {parseOptions} = require('../src/options');
const {SqsGrep} = require('../src/sqs-grep');

const emptyLog = sinon.stub();

describe('SqsGrep', function () {
    let sqs;
    const parse = args => ({
        ...parseOptions(args),
        sqs,
        log: emptyLog
    });
    beforeEach(function() {
        sqs = {
            getQueueUrl: sinon.stub(),
            getQueueAttributes: sinon.stub(),
            sendMessage: sinon.stub(),
            deleteMessage: sinon.stub(),
            receiveMessage: sinon.stub(),
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

        it('should write messages to file', async function () {
            // arrange
            try {
                fs.unlinkSync('.out');                
            } catch {
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
            assert.equal(fs.readFileSync('.out', 'utf-8'), '1\n2\n3\n');
            fs.unlinkSync('.out');
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
    });
});
