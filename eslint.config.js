const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
    js.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 2018,
            sourceType: 'commonjs',
            globals: {
                ...globals.node,
            },
        },
        rules: {
            'semi': ['error', 'always', {'omitLastInOneLineBlock': true}],
            // 'caughtErrors' defaults to 'all' since ESLint 9, but this code base
            // intentionally swallows some errors using 'catch (err) { /* ignore */ }'
            'no-unused-vars': ['error', {'argsIgnorePattern': '^_', 'caughtErrors': 'none'}],
        },
    },
];
