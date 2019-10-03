const assert = require('assert');
const sinon = require('sinon');
const {parseOptions, validateOptions, printMatchingRules} = require('../src/options');

describe('Options', function () {
    afterEach(() => sinon.restore());
    describe('#parseOptions', function () {
        it('should parse --help', function () {
            options = parseOptions(['--help']);
            assert.equal(options.help, true, 'Help should be true');
        });
        it('should parse --version', function () {
            options = parseOptions(['--version']);
            assert.equal(options.version, true, 'Version should be true');
        });
        it('should default parallel to 1', function () {
            options = parseOptions(['--version']);
            assert.equal(options.parallel, 1, 'Parallel should be 1 by default');
        });
    });
    describe('#validateOptions', function () {
        let logs, logStub;
        const hasLog = regexp => regexp.test(logs.map(s=>s.toString()).join(''));
        beforeEach(() => {
            logs = [];
            logStub = sinon.stub(console, "log").callsFake(function () { logs.push(...arguments) });
        });
        afterEach(() => logStub.restore());
        it('should show help', function () {
            parseOptions(['--help']);
            assert.equal(validateOptions(), false);
            assert.equal(hasLog(/Main options/), true, 'Should print help on console');
        });
        it('should show version', function () {
            parseOptions(['--version']);
            assert.equal(validateOptions(), false);
            assert.equal(hasLog(/sqs-grep version \d+/), true, 'Should print version on console');
            assert.equal(hasLog(/Main options/), false, 'Should not print help on console');
        });
        it('should require --queue', function () {
            parseOptions(['--parallel', '2']);
            assert.equal(validateOptions(), false);
            assert.equal(hasLog(/--queue/), true);
        });
        it('should require one of --all, --body, or --attribute', function () {
            parseOptions(['--queue', 'TestQueue']);
            assert.equal(validateOptions(), false);
            assert.equal(hasLog(/--all.*--body.*--attribute/), true);
        });
        it('should not allow both --copyTo and --delete', function () {
            parseOptions(['--queue', 'TestQueue', '--all', '--copyTo=A', '--delete']);
            assert.equal(validateOptions(), false);
            assert.equal(hasLog(/ERROR: You can't specify both .*--copyTo.* and .*--delete.*/), true);
        });
        [['--all'], ['--body', 'Test'], ['--attribute', 'key=val']].forEach(arg => {
            it(`should pass with ${arg[0]}`, function () {
                parseOptions(['--queue', 'TestQueue', ...arg]);
                assert.equal(validateOptions(), true);
                assert.equal(logs.length, 0);
            });
        });
    });
    describe('#printMatchingRules', function () {
        let logs, logStub;
        const hasLog = regexp => regexp.test(logs.map(s=>s.toString()).join(''));
        beforeEach(() => {
            logs = [];
            logStub = sinon.stub(console, "log").callsFake(function () { logs.push(...arguments) });
        });
        afterEach(() => logStub.restore());
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
                parseOptions(args);
                printMatchingRules();
                assert.equal(hasLog(regexp), true, `Log should have the regexp ${regexp}`);
            });
        });
    });
});
