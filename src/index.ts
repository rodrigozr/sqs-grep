/**
 * Public entry point of the `sqs-grep` package.
 *
 *     import { SqsGrep } from 'sqs-grep';
 *
 * The package is an ES module. CommonJS consumers on Node.js 22.12+ can still use
 * `const { SqsGrep } = require('sqs-grep')`, as Node can `require()` ES modules
 * natively. TypeScript consumers additionally get the exported types.
 */
export {SqsGrep, MESSAGE_INDEX} from './sqs-grep.js';
export type {SqsGrepMessage, SqsGrepResult, UserScriptHooks, UserScript} from './sqs-grep.js';
export {parseOptions, validateOptions, printMatchingRules, showHelp, showVersion} from './options.js';
export type {SqsGrepOptions, AttributeMatcher} from './options.js';
export {StateFile, STATE_FILE_VERSION, DEFAULT_FLUSH_INTERVAL} from './state-file.js';
export type {StateFileContents, StateFileParams} from './state-file.js';
export type {Logger, SqsClient, SnsClient} from './types.js';
