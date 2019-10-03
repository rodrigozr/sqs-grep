#!/bin/sh

# Run the tests with code coverage
./node_modules/.bin/istanbul cover \
    ./node_modules/mocha/bin/mocha --report lcovonly -- -R spec || exit 1

# When running on Travis, also upload the coverate results to coveralls
[ "$TRAVIS_JOB_ID" = "" ] || cat ./coverage/lcov.info | ./node_modules/coveralls/bin/coveralls.js || exit 1