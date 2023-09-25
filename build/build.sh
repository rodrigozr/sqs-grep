#!/bin/sh
rm sqs-grep sqs-grep.exe sqs-grep-* > /dev/null 2> /dev/null
echo Bulding executables...
pkg ../ --public -t node18-linux-x64,node18-linux-arm64,node18-macos-x64,node18-macos-arm64,node18-win-x64,node18-win-arm64 || exit 1

pack_unix()
{
    FILE=$1
    TARGET=$2
    echo Packaging $FILE binary as $TARGET...
    mv $FILE sqs-grep || exit 1
    tar -cjf $TARGET sqs-grep || exit 1
    rm sqs-grep || exit 1
}

pack_win()
{
    FILE=$1
    TARGET=$2
    echo Packaging $FILE binary as $TARGET...
    mv $FILE sqs-grep.exe || exit 1
    zip -9 $TARGET sqs-grep.exe || exit 1
    rm sqs-grep.exe || exit 1
}


# Linux and MacOS
pack_unix sqs-grep-linux-x64    sqs-grep-linux-x64.tbz
pack_unix sqs-grep-linux-arm64  sqs-grep-linux-arm64.tbz
pack_unix sqs-grep-macos-x64    sqs-grep-macos-x64.tbz
pack_unix sqs-grep-macos-arm64  sqs-grep-macos-arm64.tbz

# Windows
pack_win sqs-grep-win-x64.exe   sqs-grep-win-x64.zip
pack_win sqs-grep-win-arm64.exe sqs-grep-win-arm64.zip
