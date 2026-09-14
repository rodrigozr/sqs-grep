// `password-prompt` does not ship type definitions and has no @types package.
// Only the default (masked) prompt is used by sqs-grep.
declare module 'password-prompt' {
    interface PasswordPromptOptions {
        /** Print `*` for each character typed (default). Set to false to hide input entirely */
        method?: 'mask' | 'hide';
        /** Reject empty input */
        required?: boolean;
        /** Value returned when the input is empty */
        default?: string;
    }

    /**
     * Prompts the user for a password on the terminal
     * @param ask prompt text
     * @param options prompt options
     */
    function prompt(ask: string, options?: PasswordPromptOptions): Promise<string>;

    export = prompt;
}
