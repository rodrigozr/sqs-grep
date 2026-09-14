import assert from 'assert';
import sinon from 'sinon';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {StateFile, STATE_FILE_VERSION, DEFAULT_FLUSH_INTERVAL, type StateFileParams, type StateFileContents} from '../src/state-file.js';

describe('StateFile', function () {
    let tempDir: string, stateFilePath: string, inputFilePath: string, logs: unknown[], log: sinon.SinonStub;
    const hasLog = (regexp: RegExp): boolean => regexp.test(logs.map(s => String(s)).join('\n'));
    const readState = (): StateFileContents => JSON.parse(fs.readFileSync(stateFilePath, 'utf-8'));
    const create = (params: Partial<StateFileParams> = {}): StateFile => new StateFile({
        filePath: stateFilePath,
        inputFile: inputFilePath,
        log,
        ...params,
    });

    beforeEach(function () {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqs-grep-state-'));
        stateFilePath = path.join(tempDir, 'state.json');
        inputFilePath = path.join(tempDir, 'queue.jsonl');
        logs = [];
        log = sinon.stub().callsFake((...args: unknown[]) => { logs.push(...args) });
    });
    afterEach(function () {
        sinon.restore();
        fs.rmSync(tempDir, {recursive: true, force: true});
    });

    describe('#constructor()', function () {
        it('should start with no progress', function () {
            const state = create();
            assert.equal(state.lastProcessedIndex, 0);
            assert.equal(state.unsavedCount, 0);
            assert.equal(state.pendingIndexes.size, 0);
        });
        it('should resolve the input file to an absolute path', function () {
            const state = create({inputFile: 'relative/queue.jsonl'});
            assert.equal(state.inputFile, path.resolve('relative/queue.jsonl'));
        });
        it('should accept a missing input file', function () {
            const state = create({inputFile: undefined});
            assert.equal(state.inputFile, undefined);
        });
        it('should default the flush interval', function () {
            assert.equal(create().flushInterval, DEFAULT_FLUSH_INTERVAL);
            assert.equal(create({flushInterval: 0}).flushInterval, DEFAULT_FLUSH_INTERVAL);
            assert.equal(create({flushInterval: -5}).flushInterval, DEFAULT_FLUSH_INTERVAL);
            assert.equal(create({flushInterval: undefined}).flushInterval, DEFAULT_FLUSH_INTERVAL);
        });
        it('should honour a custom flush interval', function () {
            assert.equal(create({flushInterval: 7}).flushInterval, 7);
        });
        it('should default the logger to console.log', function () {
            assert.equal(create({log: undefined}).log, console.log);
        });
    });

    describe('#load()', function () {
        it('should return 0 when the state file does not exist', function () {
            const state = create();
            assert.equal(state.load(), 0);
            assert.equal(state.lastProcessedIndex, 0);
            assert.equal(hasLog(/does not exist yet/), true);
        });
        it('should load a previously saved index', function () {
            fs.writeFileSync(stateFilePath, JSON.stringify({
                version: STATE_FILE_VERSION,
                inputFile: inputFilePath,
                lastProcessedIndex: 10,
            }));
            const state = create();
            assert.equal(state.load(), 10);
            assert.equal(state.lastProcessedIndex, 10);
        });
        it('should load a state file without an input file recorded', function () {
            fs.writeFileSync(stateFilePath, JSON.stringify({lastProcessedIndex: 3}));
            assert.equal(create().load(), 3);
        });
        it('should truncate a fractional index', function () {
            fs.writeFileSync(stateFilePath, JSON.stringify({lastProcessedIndex: 10.9}));
            assert.equal(create().load(), 10);
        });
        it('should ignore an invalid JSON state file', function () {
            fs.writeFileSync(stateFilePath, 'not-json{');
            assert.equal(create().load(), 0);
            assert.equal(hasLog(/is not valid JSON and will be ignored/), true);
        });
        it('should ignore an empty state file', function () {
            fs.writeFileSync(stateFilePath, '');
            assert.equal(create().load(), 0);
            assert.equal(hasLog(/is not valid JSON and will be ignored/), true);
        });
        [
            ['null contents', 'null'],
            ['a missing index', '{}'],
            ['a non-numeric index', '{"lastProcessedIndex":"10"}'],
            ['a negative index', '{"lastProcessedIndex":-1}'],
            ['an infinite index', '{"lastProcessedIndex":1e999}'],
        ].forEach(([description, contents]) => {
            it(`should ignore a state file with ${description}`, function () {
                fs.writeFileSync(stateFilePath, contents);
                assert.equal(create().load(), 0);
                assert.equal(hasLog(/does not contain a valid 'lastProcessedIndex'/), true);
            });
        });
        it('should ignore a state file which refers to another input file', function () {
            fs.writeFileSync(stateFilePath, JSON.stringify({
                inputFile: path.join(tempDir, 'another-queue.jsonl'),
                lastProcessedIndex: 10,
            }));
            const state = create();
            assert.equal(state.load(), 0);
            assert.equal(state.lastProcessedIndex, 0);
            assert.equal(hasLog(/refers to a different input file/), true);
        });
        it('should raise unexpected file system errors', function () {
            const state = create({filePath: tempDir});
            assert.throws(() => state.load(), (err: NodeJS.ErrnoException) => err.code === 'EISDIR');
        });
    });

    describe('#markProcessed()', function () {
        it('should advance the index sequentially', function () {
            const state = create({flushInterval: 1000});
            assert.equal(state.markProcessed(1), true);
            assert.equal(state.lastProcessedIndex, 1);
            assert.equal(state.markProcessed(2), true);
            assert.equal(state.lastProcessedIndex, 2);
            assert.equal(state.unsavedCount, 2);
        });
        it('should only advance over a contiguous prefix', function () {
            const state = create({flushInterval: 1000});
            // Messages completing out of order (as with --parallel)
            assert.equal(state.markProcessed(3), false);
            assert.equal(state.lastProcessedIndex, 0);
            assert.equal(state.markProcessed(2), false);
            assert.equal(state.lastProcessedIndex, 0);
            assert.equal(state.pendingIndexes.size, 2);
            // Message 1 completes and unblocks 2 and 3 at once
            assert.equal(state.markProcessed(1), true);
            assert.equal(state.lastProcessedIndex, 3);
            assert.equal(state.pendingIndexes.size, 0);
        });
        it('should ignore indexes already covered', function () {
            const state = create({flushInterval: 1000});
            state.markProcessed(1);
            state.markProcessed(2);
            assert.equal(state.markProcessed(2), false);
            assert.equal(state.markProcessed(1), false);
            assert.equal(state.lastProcessedIndex, 2);
            assert.equal(state.unsavedCount, 2);
        });
        it('should ignore indexes below a resumed point', function () {
            fs.writeFileSync(stateFilePath, JSON.stringify({lastProcessedIndex: 5}));
            const state = create({flushInterval: 1000});
            state.load();
            assert.equal(state.markProcessed(3), false);
            assert.equal(state.lastProcessedIndex, 5);
            assert.equal(state.markProcessed(6), true);
            assert.equal(state.lastProcessedIndex, 6);
        });
        [undefined, null, 'abc', NaN, Infinity, {}].forEach((index: unknown) => {
            it(`should ignore the invalid index ${String(index)}`, function () {
                const state = create({flushInterval: 1000});
                assert.equal(state.markProcessed(index), false);
                assert.equal(state.lastProcessedIndex, 0);
                assert.equal(state.pendingIndexes.size, 0);
            });
        });
        it('should save the state once the flush interval is reached', function () {
            const state = create({flushInterval: 3});
            state.markProcessed(1);
            state.markProcessed(2);
            assert.equal(fs.existsSync(stateFilePath), false, 'Should not save before the interval');
            state.markProcessed(3);
            assert.equal(readState().lastProcessedIndex, 3);
            assert.equal(state.unsavedCount, 0);
        });
        it('should not save more often than the flush interval', function () {
            const state = create({flushInterval: 2});
            const save = sinon.spy(state, 'save');
            for (let i = 1; i <= 10; i++) {
                state.markProcessed(i);
            }
            assert.equal(save.callCount, 5);
            assert.equal(readState().lastProcessedIndex, 10);
        });
        it('should save when out-of-order completions cross the flush interval', function () {
            const state = create({flushInterval: 3});
            state.markProcessed(3);
            state.markProcessed(2);
            assert.equal(fs.existsSync(stateFilePath), false, 'Should not save while blocked on message 1');
            // Completing message 1 advances the index by 3 at once
            state.markProcessed(1);
            assert.equal(readState().lastProcessedIndex, 3);
        });
        it('should not save when the index does not advance', function () {
            const state = create({flushInterval: 1});
            state.markProcessed(2);
            assert.equal(fs.existsSync(stateFilePath), false);
        });
    });

    describe('#save()', function () {
        it('should write the full state', function () {
            const state = create({flushInterval: 1000});
            state.markProcessed(1);
            assert.equal(state.save(), true);
            const saved = readState();
            assert.equal(saved.version, STATE_FILE_VERSION);
            assert.equal(saved.inputFile, inputFilePath);
            assert.equal(saved.lastProcessedIndex, 1);
            assert.equal(typeof saved.updatedAt, 'string');
            assert.equal(isNaN(new Date(saved.updatedAt).getTime()), false);
        });
        it('should reset the unsaved counter', function () {
            const state = create({flushInterval: 1000});
            state.markProcessed(1);
            assert.equal(state.unsavedCount, 1);
            state.save();
            assert.equal(state.unsavedCount, 0);
        });
        it('should do nothing when there is no new progress', function () {
            const state = create({flushInterval: 1000});
            assert.equal(state.save(), false);
            assert.equal(fs.existsSync(stateFilePath), false);
        });
        it('should do nothing when the progress was already saved', function () {
            const state = create({flushInterval: 1});
            state.markProcessed(1);
            fs.unlinkSync(stateFilePath);
            assert.equal(state.save(), false);
            assert.equal(fs.existsSync(stateFilePath), false);
        });
        it('should write when forced even without new progress', function () {
            const state = create({flushInterval: 1000});
            assert.equal(state.save(true), true);
            assert.equal(readState().lastProcessedIndex, 0);
        });
        it('should not leave a temporary file behind', function () {
            const state = create({flushInterval: 1000});
            state.markProcessed(1);
            state.save();
            assert.equal(fs.existsSync(`${stateFilePath}.tmp`), false);
            assert.deepEqual(fs.readdirSync(tempDir), ['state.json']);
        });
        it('should overwrite a previously saved state', function () {
            const state = create({flushInterval: 1000});
            state.markProcessed(1);
            state.save();
            state.markProcessed(2);
            state.save();
            assert.equal(readState().lastProcessedIndex, 2);
        });
        it('should raise unexpected file system errors', function () {
            const state = create({filePath: path.join(tempDir, 'missing-dir', 'state.json'), flushInterval: 1000});
            state.markProcessed(1);
            assert.throws(() => state.save(), (err: NodeJS.ErrnoException) => err.code === 'ENOENT');
        });
    });

    describe('resume round-trip', function () {
        it('should resume exactly where the previous run stopped', function () {
            const first = create({flushInterval: 1000});
            assert.equal(first.load(), 0);
            for (let i = 1; i <= 10; i++) {
                first.markProcessed(i);
            }
            first.save();

            const second = create({flushInterval: 1000});
            assert.equal(second.load(), 10, 'Should resume after message 10');
            // The next message processed is number 11
            assert.equal(second.markProcessed(11), true);
            assert.equal(second.lastProcessedIndex, 11);
            second.save();
            assert.equal(readState().lastProcessedIndex, 11);
        });
    });
});
