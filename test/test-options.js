/* eslint-disable no-undef */
const assert = require('assert');
const sinon = require('sinon');
const {parseOptions, validateOptions, printMatchingRules} = require('../src/options');

describe('Options', function () {
    afterEach(() => sinon.restore());
    describe('#parseOptions()', function () {
        it('should parse --help', function () {
            const options = parseOptions(['--help']);
            assert.equal(options.help, true, 'Help should be true');
        });
        it('should parse --version', function () {
            const options = parseOptions(['--version']);
            assert.equal(options.version, true, 'Version should be true');
        });
        it('should default parallel to 1', function () {
            const options = parseOptions(['--version']);
            assert.equal(options.parallel, 1, 'Parallel should be 1 by default');
        });
    });
    describe('#validateOptions()', function () {
        let logs, log;
        const hasLog = regexp => regexp.test(logs.map(s=>s.toString()).join(''));
        beforeEach(() => {
            logs = [];
            log = sinon.stub().callsFake(function () { logs.push(...arguments) });
        });
        it('should show help', function () {
            const options = parseOptions(['--help']);
            assert.equal(validateOptions(options, log), false);
            assert.equal(hasLog(/Main options/), true, 'Should print help on console');
        });
        it('should show version', function () {
            const options = parseOptions(['--version']);
            assert.equal(validateOptions(options, log), false);
            assert.equal(hasLog(/sqs-grep version \d+/), true, 'Should print version on console');
            assert.equal(hasLog(/Main options/), false, 'Should not print help on console');
        });
        it('should require --queue or --inputFile', function () {
            const options = parseOptions(['--parallel', '2']);
            assert.equal(validateOptions(options, log), false);
            assert.equal(hasLog(/--queue/), true);
            assert.equal(hasLog(/--inputFile/), true);
        });
        it('should require one of --all, --body, or --attribute', function () {
            const options = parseOptions(['--queue', 'TestQueue']);
            assert.equal(validateOptions(options, log), false);
            assert.equal(hasLog(/--all.*--body.*--attribute/), true);
        });
        it('should not allow both --copyTo and --delete', function () {
            const options = parseOptions(['--queue', 'TestQueue', '--all', '--copyTo=A', '--delete']);
            assert.equal(validateOptions(options, log), false);
            assert.equal(hasLog(/ERROR: You can't specify both .*--copyTo.* and .*--delete.*/), true);
        });
        it('should not allow missing --parallel', function () {
            const options = parseOptions(['--queue', 'TestQueue', '--all']);
            options.parallel = undefined;
            assert.equal(validateOptions(options, log), false);
            assert.equal(hasLog(/ERROR: Invalid .*--parallel.* value \(must be greater than 0\)/), true);
        });
        it('should not allow invalid --parallel', function () {
            const options = parseOptions(['--queue', 'TestQueue', '--all', '--parallel', '0']);
            assert.equal(validateOptions(options, log), false);
            assert.equal(hasLog(/ERROR: Invalid .*--parallel.* value \(must be greater than 0\)/), true);
        });
        it('should not allow missing --timeout', function () {
            const options = parseOptions(['--queue', 'TestQueue', '--all']);
            options.timeout = undefined;
            assert.equal(validateOptions(options, log), false);
            assert.equal(hasLog(/ERROR: Invalid .*--timeout.* value \(must be greater than 0\)/), true);
        });
        it('should not allow invalid --timeout', function () {
            const options = parseOptions(['--queue', 'TestQueue', '--all', '--timeout', '0']);
            assert.equal(validateOptions(options, log), false);
            assert.equal(hasLog(/ERROR: Invalid .*--timeout.* value \(must be greater than 0\)/), true);
        });
        it('should not allow both --inputFile and --delete', function () {
            const options = parseOptions(['--inputFile', 'TestFile.txt', '--all', '--delete']);
            assert.equal(validateOptions(options, log), false);
            assert.equal(hasLog(/ERROR: You can't specify both .*--inputFile.* and .*--delete.*/), true);
        });
        it('should not allow both --inputFile and --moveTo', function () {
            const options = parseOptions(['--inputFile', 'TestFile.txt', '--all', '--moveTo', 'Dest']);
            assert.equal(validateOptions(options, log), false);
            assert.equal(hasLog(/ERROR: You can't specify both .*--inputFile.* and .*--moveTo.*/), true);
        });
        it('should not allow both --inputFile and --queue', function () {
            const options = parseOptions(['--inputFile', 'TestFile.txt', '--all', '--queue', 'TestQueue']);
            assert.equal(validateOptions(options, log), false);
            assert.equal(hasLog(/ERROR: You can't specify both .*--queue.* and .*--inputFile.*/), true);
        });
        [['--all'], ['--body', 'Test'], ['--attribute', 'key=val']].forEach(arg => {
            it(`should pass with ${arg[0]}`, function () {
                const options = parseOptions(['--queue', 'TestQueue', ...arg]);
                assert.equal(validateOptions(options, log), true);
                assert.equal(logs.length, 0);
            });
        });
    });
    describe('#printMatchingRules()', function () {
        let logs, log;
        const hasLog = regexp => regexp.test(logs.map(s=>s.toString()).join(''));
        beforeEach(() => {
            logs = [];
            log = sinon.stub().callsFake(function () { logs.push(...arguments) });
        });
        [
            [['--all'], /Will match .*ALL.* messages in the queue/],
            [['--all', '--delete'], /Will .*DELETE.* .*ALL.* messages in the queue/],
            [['--all', '--moveTo=A'], /Will .*move.* .*ALL.* messages in the queue/],
            [['--body=Test'], /Will match messages containing the RegExp .*\/Test\/.* in its body/],
            [['--body=Test', '--negate'], /Will match messages .*not containing.* the RegExp .*\/Test\/.* in its body/],
            [['--body=Test', '--delete'], /Will .*DELETE.* messages containing the RegExp .*\/Test\/.* in its body/],
            [['--body=Test', '--delete', '--negate'], /Will .*DELETE.* messages .*not containing.* the RegExp .*\/Test\/.* in its body/],
            [['--body=Test', '--moveTo=A'], /Will .*move.* messages containing the RegExp .*\/Test\/.* in its body/],
            [['--body=Test', '--copyTo=A'], /Will .*copy.* messages containing the RegExp .*\/Test\/.* in its body/],
            [['--body=Test', '--copyTo=A', '--moveTo=B'], /Will .*copy and move.* messages containing the RegExp .*\/Test\/.* in its body/],
            [
                ['--attribute=key=val'],
                /Will match messages containing an attribute named '.*key.*' with its value containing the RegExp .*\/val\/.*/
            ],
            [
                ['--attribute=key=val', '--negate'],
                /Will match messages containing an attribute named '.*key.*' with its value .*not containing.* the RegExp .*\/val\/.*/
            ],
            [
                ['--attribute=key=val', '--delete', '--negate'],
                /Will .*DELETE.* messages containing an attribute named '.*key.*' with its value .*not containing.* the RegExp .*\/val\/.*/
            ],
            [
                ['--body=Test', '--attribute=key=val', '--delete', '--negate'],
                /Will .*DELETE.* messages .*not containing.* the RegExp .*\/Test\/.* in its body.*Will .*DELETE.* messages containing an attribute named '.*key.*' with its value .*not containing.* the RegExp .*\/val\/.*/
            ],
        ].forEach(([args, regexp]) => {
            it(`should show correct info for ${args}`, function () {
                const options = parseOptions(args);
                printMatchingRules(options, log);
                assert.equal(hasLog(regexp), true, `Log should have the regexp ${regexp}`);
            });
        });
    });
});
