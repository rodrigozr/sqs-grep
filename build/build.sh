#!/bin/sh
rm sqs-grep sqs-grep.exe sqs-grep-* > /dev/null 2> /dev/null
echo Bulding executables...
pkg ../ --public -t node12-linux-x64,node12-macos-x64,node12-win-x64 || exit 1

# Linux
echo Packaging Linux x64 binary...
mv sqs-grep-linux sqs-grep || exit 1
tar -cjf sqs-grep-linux-x64.tbz sqs-grep || exit 1
rm sqs-grep || exit 1

# MacOS
echo Packaging MacOS x64 binary...
mv sqs-grep-macos sqs-grep || exit 1
tar -cjf sqs-grep-macos-x64.tbz sqs-grep || exit 1
rm sqs-grep || exit 1

# Windows
echo Packaging Windows x64 binary...
mv sqs-grep-win.exe sqs-grep.exe || exit 1
zip -9 sqs-grep-win-x64.zip sqs-grep.exe || exit 1
rm sqs-grep.exe || exit 1
