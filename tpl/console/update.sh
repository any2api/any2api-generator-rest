#!/bin/bash

#BASE_DIR=$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )
BASE_DIR=`dirname $0`
V1_DIR="$BASE_DIR/v1"

TEMP_DIR="/tmp/api-console"

git clone https://github.com/mulesoft/api-console.git $TEMP_DIR

for DIR in "img" "authentication" "fonts" "scripts" "styles"; do
  rm -rf $V1_DIR/$DIR
  cp -a $TEMP_DIR/dist/$DIR $V1_DIR/$DIR
done

rm -rf $TEMP_DIR
