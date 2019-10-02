#!/bin/sh
rm sqs-grep sqs-grep.exe sqs-grep-* > /dev/null 2> /dev/null
pkg ../ -t node10-linux-x64,node10-macos-x64,node10-win-x64 || exit 1

# Linux
mv sqs-grep-linux sqs-grep
tar -cjf sqs-grep-linux-x64.tbz sqs-grep
rm sqs-grep

# MacOS
mv sqs-grep-macos sqs-grep
tar -cjf sqs-grep-macos-x64.tbz sqs-grep
rm sqs-grep

# Windows
mv sqs-grep-win.exe sqs-grep.exe
zip -9 sqs-grep-win-x64.zip sqs-grep.exe
rm sqs-grep.exe
