import assert from 'assert';
import * as sqsGrepPackage from '../src/index.js';
import {SqsGrep, MESSAGE_INDEX} from '../src/sqs-grep.js';
import {parseOptions, validateOptions, printMatchingRules, showHelp, showVersion} from '../src/options.js';
import {StateFile, STATE_FILE_VERSION, DEFAULT_FLUSH_INTERVAL} from '../src/state-file.js';

/**
 * These tests pin the public surface of the package entry point, so that JavaScript
 * consumers keep working across the TypeScript migration.
 */
describe('package entry point', function () {
    it('should export SqsGrep as before', function () {
        assert.strictEqual(sqsGrepPackage.SqsGrep, SqsGrep);
        assert.strictEqual(sqsGrepPackage.MESSAGE_INDEX, MESSAGE_INDEX);
    });
    it('should export the options helpers', function () {
        assert.strictEqual(sqsGrepPackage.parseOptions, parseOptions);
        assert.strictEqual(sqsGrepPackage.validateOptions, validateOptions);
        assert.strictEqual(sqsGrepPackage.printMatchingRules, printMatchingRules);
        assert.strictEqual(sqsGrepPackage.showHelp, showHelp);
        assert.strictEqual(sqsGrepPackage.showVersion, showVersion);
    });
    it('should export the state file helpers', function () {
        assert.strictEqual(sqsGrepPackage.StateFile, StateFile);
        assert.strictEqual(sqsGrepPackage.STATE_FILE_VERSION, STATE_FILE_VERSION);
        assert.strictEqual(sqsGrepPackage.DEFAULT_FLUSH_INTERVAL, DEFAULT_FLUSH_INTERVAL);
    });
    it('should be usable the way JavaScript clients use it', async function () {
        // Mirrors: import { SqsGrep } from 'sqs-grep'; new SqsGrep({...}).run()
        const logs: string[] = [], outputs: string[] = [];
        const {SqsGrep: SqsGrepFromPackage} = sqsGrepPackage;
        const instance = new SqsGrepFromPackage({
            help: true,
            log: msg => { logs.push(String(msg)) },
            out: msg => { outputs.push(String(msg)) },
        });
        assert.equal(await instance.run(), null);
        assert.equal(outputs.some(l => /sqs-grep version/.test(l)), true, '--help is written to the results writer');
        assert.equal(logs.length, 0, 'and nothing is logged as a diagnostic');
    });
});
