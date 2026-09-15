import assert from 'assert';
import sinon from 'sinon';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {parseOptions, validateOptions, printMatchingRules, readPackageVersion} from '../src/options.js';

/** Collects everything logged, and lets tests match against it */
const logCollector = (): {logs: unknown[]; log: sinon.SinonStub; hasLog: (regexp: RegExp) => boolean} => {
    const logs: unknown[] = [];
    const log = sinon.stub().callsFake((...args: unknown[]) => { logs.push(...args) });
    return {logs, log, hasLog: regexp => regexp.test(logs.map(s => String(s)).join(''))};
};

describe('Options', function () {
    afterEach(() => sinon.restore());
    describe('#readPackageVersion()', function () {
        it('should read the version of this package by default', function () {
            // Tests always run from the repository root
            const expected = (JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8')) as {version: string}).version;
            assert.equal(readPackageVersion(), expected);
            assert.match(readPackageVersion(), /^\d+\.\d+\.\d+/);
        });
        it('should walk up the directory tree to the nearest package.json', function () {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqs-grep-pkg-'));
            try {
                fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({version: '9.8.7'}));
                const nested = path.join(tempDir, 'a', 'b', 'c');
                fs.mkdirSync(nested, {recursive: true});
                assert.equal(readPackageVersion(nested), '9.8.7');
            } finally {
                fs.rmSync(tempDir, {recursive: true, force: true});
            }
        });
        it('should fail when no package.json can be found', function () {
            sinon.replace(fs, 'readFileSync', sinon.fake.throws(new Error('ENOENT')));
            assert.throws(() => readPackageVersion('/nowhere/to/be/found'), /Could not find the sqs-grep package.json above '\/nowhere\/to\/be\/found'/);
        });
    });
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
        it('should default maxRetries to 3', function () {
            const options = parseOptions(['--version']);
            assert.equal(options.maxRetries, 3, 'maxRetries should be 3 by default');
        });
        it('should not set stateFile by default', function () {
            const options = parseOptions(['--version']);
            assert.equal(options.stateFile, undefined, 'stateFile should be undefined by default');
        });
        it('should default stateFileInterval to 100', function () {
            const options = parseOptions(['--version']);
            assert.equal(options.stateFileInterval, 100, 'stateFileInterval should be 100 by default');
        });
        it('should parse --stateFile and --stateFileInterval', function () {
            const options = parseOptions(['--stateFile', 'state.json', '--stateFileInterval', '5']);
            assert.equal(options.stateFile, 'state.json');
            assert.equal(options.stateFileInterval, 5);
        });
    });
    describe('#validateOptions()', function () {
        let logs: unknown[], log: sinon.SinonStub, hasLog: (regexp: RegExp) => boolean;
        beforeEach(() => {
            ({logs, log, hasLog} = logCollector());
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
        it('should write --help and --version to the results writer when one is given', function () {
            const {logs: outputs, log: out} = logCollector();
            assert.equal(validateOptions(parseOptions(['--help']), log, out), false);
            assert.equal(validateOptions(parseOptions(['--version']), log, out), false);
            const written = outputs.map(s => String(s)).join('');
            assert.match(written, /Main options/, 'help is a result, not a diagnostic');
            assert.match(written, /sqs-grep version \d+/, 'the version is a result, not a diagnostic');
            assert.equal(logs.length, 0, 'nothing must be logged as a diagnostic');
        });
        it('should write validation errors to the log even when a results writer is given', function () {
            const {logs: outputs, log: out} = logCollector();
            assert.equal(validateOptions(parseOptions(['--parallel', '2']), log, out), false);
            assert.equal(hasLog(/--queue/), true);
            assert.equal(outputs.length, 0, 'errors must not pollute the results (stdout)');
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
        it('should not allow both --moveTo and --redrive', function () {
            const options = parseOptions(['--queue', 'TestQueue', '--all', '--moveTo=A', '--redrive']);
            assert.equal(validateOptions(options, log), false);
            assert.equal(hasLog(/ERROR: You can't specify both .*--moveTo.* and .*--redrive.*/), true);
        });
        it('should not allow missing --parallel', function () {
            const options = parseOptions(['--queue', 'TestQueue', '--all']);
            (options as {parallel?: number}).parallel = undefined;
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
            (options as {timeout?: number}).timeout = undefined;
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
        it('should not allow --stateFile without --inputFile', function () {
            const options = parseOptions(['--queue', 'TestQueue', '--all', '--stateFile', 'state.json']);
            assert.equal(validateOptions(options, log), false);
            assert.equal(hasLog(/ERROR: .*--stateFile.* can only be used together with .*--inputFile.*/), true);
        });
        it('should allow --stateFile with --inputFile', function () {
            const options = parseOptions(['--inputFile', 'TestFile.txt', '--all', '--stateFile', 'state.json']);
            assert.equal(validateOptions(options, log), true);
            assert.equal(logs.length, 0);
        });
        it('should not allow invalid --stateFileInterval', function () {
            const options = parseOptions(['--inputFile', 'TestFile.txt', '--all', '--stateFile', 'state.json', '--stateFileInterval', '0']);
            assert.equal(validateOptions(options, log), false);
            assert.equal(hasLog(/ERROR: Invalid .*--stateFileInterval.* value \(must be greater than 0\)/), true);
        });
        it('should not allow missing --stateFileInterval', function () {
            const options = parseOptions(['--inputFile', 'TestFile.txt', '--all', '--stateFile', 'state.json']);
            (options as {stateFileInterval?: number}).stateFileInterval = undefined;
            assert.equal(validateOptions(options, log), false);
            assert.equal(hasLog(/ERROR: Invalid .*--stateFileInterval.* value \(must be greater than 0\)/), true);
        });
        it('should ignore an invalid --stateFileInterval when --stateFile is not set', function () {
            const options = parseOptions(['--inputFile', 'TestFile.txt', '--all', '--stateFileInterval', '0']);
            assert.equal(validateOptions(options, log), true);
            assert.equal(logs.length, 0);
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
        let log: sinon.SinonStub, hasLog: (regexp: RegExp) => boolean;
        beforeEach(() => {
            ({log, hasLog} = logCollector());
        });
        ([
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
        ] as [string[], RegExp][]).forEach(([args, regexp]) => {
            it(`should show correct info for ${args}`, function () {
                const options = parseOptions(args);
                printMatchingRules(options, log);
                assert.equal(hasLog(regexp), true, `Log should have the regexp ${regexp}`);
            });
        });
    });
});
