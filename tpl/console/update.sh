#!/bin/bash

#BASE_DIR=$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )
BASE_DIR=`dirname $0`

TEMP_DIR="/tmp/api-console"

git clone https://github.com/mulesoft/api-console.git $TEMP_DIR

for DIR in "authentication" "fonts" "scripts" "styles"; do
  rm -rf $BASE_DIR/$DIR
  cp -a $TEMP_DIR/dist/$DIR $BASE_DIR/$DIR
done

rm -rf $TEMP_DIR
