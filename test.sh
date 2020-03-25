#!/bin/sh

# Fast-fail smoke test
src/main.js --version || exit 1

# Run the tests with code coverage
./node_modules/.bin/nyc ./node_modules/mocha/bin/mocha || exit 1

# When running on Travis, also upload the coverate results to coveralls
[ "$TRAVIS_JOB_ID" = "" ] || cat ./coverage/lcov.info | ./node_modules/coveralls/bin/coveralls.js || exit 1

# Run vulneravilities tests
[ "$SNYK_TOKEN" = "" ] || npm run snyk-ci || exit 1