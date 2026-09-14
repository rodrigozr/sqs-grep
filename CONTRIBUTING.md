## Contributing
Contributing to sqs-grep is very simple:
1. Fork it on GitHub
2. Change package.json to increment the version number
3. Add your contribution to your fork, including unit tests for it
4. Run `npm run integration-test && npm test` and make sure that all tests are passing and the code coverage is at 100%
   (the integration tests need Docker/Finch to start a LocalStack container; `npm run test:watch` re-runs the unit tests on every change)
5. Submit a pull-request

Thanks!
