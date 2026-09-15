/**
 * Types shared across the sqs-grep modules.
 *
 * Anything here is part of the public API (re-exported from the package entry
 * point), so it must not depend on implementation modules.
 */
import type {SNS} from '@aws-sdk/client-sns';
import type {SQS} from '@aws-sdk/client-sqs';

/**
 * Function used by sqs-grep to write a line of text. Two of these are used:
 * - `log` for diagnostics (progress, warnings, errors), defaulting to
 *   `console.error`, i.e. **stderr**
 * - `out` for results (matched messages, `--help`, `--version`), defaulting to
 *   `console.log`, i.e. **stdout**
 *
 * Keeping them apart is what makes `sqs-grep ... | jq` work: only the matched
 * messages reach the pipe.
 */
export type Logger = (message?: unknown, ...optionalParams: unknown[]) => void;

/**
 * The SQS client surface used by sqs-grep (a subset of the AWS SDK client),
 * declared separately so that tests and embedders can inject a custom one.
 */
export type SqsClient = Pick<SQS,
    'receiveMessage' | 'sendMessage' | 'deleteMessage' | 'getQueueUrl' | 'getQueueAttributes' | 'listDeadLetterSourceQueues'>;

/**
 * The SNS client surface used by sqs-grep
 */
export type SnsClient = Pick<SNS, 'publish' | 'getTopicAttributes'>;
