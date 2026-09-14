/**
 * Types shared across the sqs-grep modules.
 *
 * Anything here is part of the public API (re-exported from the package entry
 * point), so it must not depend on implementation modules.
 */
import type {SNS} from '@aws-sdk/client-sns';
import type {SQS} from '@aws-sdk/client-sqs';

/**
 * Logger function used across sqs-grep (defaults to `console.log`)
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
