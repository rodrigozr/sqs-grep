const fs = require('fs');
const os = require('os');
const path = require('path');
const chalk = require('chalk');

/**
 * Version of the state file format, so that we can evolve it in the future
 */
const STATE_FILE_VERSION = 1;

/**
 * Default number of processed messages between state file saves
 */
const DEFAULT_FLUSH_INTERVAL = 100;

/**
 * Keeps track of how many messages from an --inputFile have already been
 * processed, and persists that information into a state file so that a
 * future run can resume from the next unprocessed message.
 *
 * Message indexes are 1-based (the first message in the file is number 1),
 * and only a fully contiguous prefix of processed messages is ever persisted.
 * This makes the state safe even when messages complete out of order (which
 * happens when --parallel is greater than 1): a message is only considered
 * "done" for resume purposes once every message before it is also done.
 */
class StateFile {
    /**
     * Class constructor
     * @param {Object} params parameters
     * @param {String} params.filePath path of the state file to read/write
     * @param {String} params.inputFile path of the input file this state refers to
     * @param {Number} params.flushInterval number of processed messages between saves
     * @param {Function} params.log logger to use
     */
    constructor({filePath, inputFile, flushInterval, log}) {
        this.filePath = filePath;
        this.inputFile = inputFile ? path.resolve(inputFile) : undefined;
        this.flushInterval = flushInterval > 0 ? flushInterval : DEFAULT_FLUSH_INTERVAL;
        this.log = log || console.log;
        // Highest index such that all messages from 1 to lastProcessedIndex are processed
        this.lastProcessedIndex = 0;
        // Indexes which completed out of order and are waiting for their predecessors
        this.pendingIndexes = new Set();
        // Number of processed messages not yet persisted to disk
        this.unsavedCount = 0;
    }

    /**
     * Loads the state file (when it exists) and returns the index of the last
     * message which was fully processed by a previous run.
     *
     * Missing, empty, corrupt or mismatched state files are ignored (with a
     * warning), causing the processing to start from the first message.
     * @returns {Number} index of the last processed message (0 when starting over)
     */
    load() {
        let content;
        try {
            content = fs.readFileSync(this.filePath, 'utf-8');
        } catch (err) {
            if (err.code === 'ENOENT') {
                this.log(chalk`State file '{green ${this.filePath}}' does not exist yet - starting from the first message.`);
                return 0;
            }
            // Anything else (permissions, directory, ...) is a real problem
            throw err;
        }
        let state;
        try {
            state = JSON.parse(content);
        } catch (err) {
            this.log(chalk`{yellow WARNING: State file '${this.filePath}' is not valid JSON and will be ignored - starting from the first message.}`);
            return 0;
        }
        if (!state || typeof state.lastProcessedIndex !== 'number'
            || !isFinite(state.lastProcessedIndex) || state.lastProcessedIndex < 0) {
            this.log(chalk`{yellow WARNING: State file '${this.filePath}' does not contain a valid 'lastProcessedIndex' and will be ignored - starting from the first message.}`);
            return 0;
        }
        if (state.inputFile && this.inputFile && state.inputFile !== this.inputFile) {
            this.log(chalk`{yellow WARNING: State file '${this.filePath}' refers to a different input file ('${state.inputFile}') and will be ignored - starting from the first message.}`);
            return 0;
        }
        this.lastProcessedIndex = Math.floor(state.lastProcessedIndex);
        return this.lastProcessedIndex;
    }

    /**
     * Marks a message index as fully processed, advancing the resume point when
     * possible, and saving the state file once enough messages were processed.
     * @param {Number} index 1-based index of the processed message
     * @returns {Boolean} true when the resume point has advanced
     */
    markProcessed(index) {
        if (typeof index !== 'number' || !isFinite(index) || index <= this.lastProcessedIndex) {
            // Not a valid index, or already covered by the current resume point
            return false;
        }
        this.pendingIndexes.add(index);
        let advanced = false;
        while (this.pendingIndexes.delete(this.lastProcessedIndex + 1)) {
            this.lastProcessedIndex++;
            this.unsavedCount++;
            advanced = true;
        }
        if (advanced && this.unsavedCount >= this.flushInterval) {
            this.save();
        }
        return advanced;
    }

    /**
     * Saves the current state to disk, unless there is nothing new to save.
     *
     * The file is written to a temporary file and then renamed, so that an
     * interrupted write can never leave a partially written state file behind.
     * @param {Boolean} force saves even when there is nothing new to save
     * @returns {Boolean} true when the state file was written
     */
    save(force) {
        if (!this.unsavedCount && !force) {
            return false;
        }
        const state = {
            version: STATE_FILE_VERSION,
            inputFile: this.inputFile,
            lastProcessedIndex: this.lastProcessedIndex,
            updatedAt: new Date().toISOString(),
        };
        const tempFilePath = `${this.filePath}.tmp`;
        fs.writeFileSync(tempFilePath, JSON.stringify(state, null, 2) + os.EOL, {encoding: 'utf-8'});
        fs.renameSync(tempFilePath, this.filePath);
        this.unsavedCount = 0;
        return true;
    }
}

module.exports = { StateFile, STATE_FILE_VERSION, DEFAULT_FLUSH_INTERVAL };
