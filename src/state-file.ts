import fs from 'fs';
import {EOL} from 'os';
import {resolve} from 'path';
import chalk from 'chalk';
import type {Logger} from './types.js';

/**
 * Version of the state file format, so that we can evolve it in the future
 */
export const STATE_FILE_VERSION = 1;

/**
 * Default number of processed messages between state file saves
 */
export const DEFAULT_FLUSH_INTERVAL = 100;

/**
 * Persisted contents of a state file
 */
export interface StateFileContents {
    version: number;
    inputFile: string | undefined;
    lastProcessedIndex: number;
    updatedAt: string;
}

/**
 * Parameters accepted by the {@link StateFile} constructor
 */
export interface StateFileParams {
    /** Path of the state file to read/write */
    filePath: string;
    /** Path of the input file this state refers to */
    inputFile?: string;
    /** Number of processed messages between saves */
    flushInterval?: number;
    /** Logger to use */
    log?: Logger;
}

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
export class StateFile {
    readonly filePath: string;
    readonly inputFile: string | undefined;
    readonly flushInterval: number;
    readonly log: Logger;
    /** Highest index such that all messages from 1 to lastProcessedIndex are processed */
    lastProcessedIndex = 0;
    /** Indexes which completed out of order and are waiting for their predecessors */
    readonly pendingIndexes = new Set<number>();
    /** Number of processed messages not yet persisted to disk */
    unsavedCount = 0;

    constructor({filePath, inputFile, flushInterval, log}: StateFileParams) {
        this.filePath = filePath;
        this.inputFile = inputFile ? resolve(inputFile) : undefined;
        this.flushInterval = flushInterval !== undefined && flushInterval > 0 ? flushInterval : DEFAULT_FLUSH_INTERVAL;
        this.log = log || console.log;
    }

    /**
     * Loads the state file (when it exists) and returns the index of the last
     * message which was fully processed by a previous run.
     *
     * Missing, empty, corrupt or mismatched state files are ignored (with a
     * warning), causing the processing to start from the first message.
     * @returns index of the last processed message (0 when starting over)
     */
    load(): number {
        let content: string;
        try {
            content = fs.readFileSync(this.filePath, 'utf-8');
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                this.log(`State file '${chalk.green(this.filePath)}' does not exist yet - starting from the first message.`);
                return 0;
            }
            // Anything else (permissions, directory, ...) is a real problem
            throw err;
        }
        let state: Partial<StateFileContents> | null;
        try {
            state = JSON.parse(content) as Partial<StateFileContents> | null;
        } catch {
            this.log(chalk.yellow(`WARNING: State file '${this.filePath}' is not valid JSON and will be ignored - starting from the first message.`));
            return 0;
        }
        if (!state || typeof state.lastProcessedIndex !== 'number'
            || !isFinite(state.lastProcessedIndex) || state.lastProcessedIndex < 0) {
            this.log(chalk.yellow(`WARNING: State file '${this.filePath}' does not contain a valid 'lastProcessedIndex' and will be ignored - starting from the first message.`));
            return 0;
        }
        if (state.inputFile && this.inputFile && state.inputFile !== this.inputFile) {
            this.log(chalk.yellow(`WARNING: State file '${this.filePath}' refers to a different input file ('${state.inputFile}') and will be ignored - starting from the first message.`));
            return 0;
        }
        this.lastProcessedIndex = Math.floor(state.lastProcessedIndex);
        return this.lastProcessedIndex;
    }

    /**
     * Marks a message index as fully processed, advancing the resume point when
     * possible, and saving the state file once enough messages were processed.
     * @param index 1-based index of the processed message
     * @returns true when the resume point has advanced
     */
    markProcessed(index: unknown): boolean {
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
     * @param force saves even when there is nothing new to save
     * @returns true when the state file was written
     */
    save(force = false): boolean {
        if (!this.unsavedCount && !force) {
            return false;
        }
        const state: StateFileContents = {
            version: STATE_FILE_VERSION,
            inputFile: this.inputFile,
            lastProcessedIndex: this.lastProcessedIndex,
            updatedAt: new Date().toISOString(),
        };
        const tempFilePath = `${this.filePath}.tmp`;
        fs.writeFileSync(tempFilePath, JSON.stringify(state, null, 2) + EOL, {encoding: 'utf-8'});
        fs.renameSync(tempFilePath, this.filePath);
        this.unsavedCount = 0;
        return true;
    }
}
