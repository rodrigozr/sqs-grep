#!/bin/sh

./node_modules/.bin/istanbul cover \
    ./node_modules/mocha/bin/mocha --report lcovonly -- -R spec && \
    [ "$TRAVIS_JOB_ID" = "" ] || (cat ./coverage/lcov.info | ./node_modules/coveralls/bin/coveralls.js) \
    || exit 1