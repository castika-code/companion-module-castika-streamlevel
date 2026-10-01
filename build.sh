#!/bin/bash
# Builds the module package (castika-streamlevel-<ver>.tgz): yarn install + yarn package.
#
# Builds never run inside the source folder. It is copied to
# $STREAMLEVEL_BUILD_DIR (default ~/streamlevel-build), yarn runs there, and only
# the finished .tgz and the yarn.lock come back.
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd -P)"
BUILD="${STREAMLEVEL_BUILD_DIR:-$HOME/streamlevel-build}"
YARN="npx --yes @yarnpkg/cli-dist@4.17.0"  # yarn 4 without needing corepack here

mkdir -p "$BUILD"
rsync -a --delete --exclude node_modules --exclude pkg --exclude '*.tgz' --exclude .yarn --exclude .git "$SRC/" "$BUILD/"
cd "$BUILD"
$YARN install
rm -f ./*.tgz
$YARN package
VER=$(node -p "require('./package.json').version")
rm -f "$SRC/castika-streamlevel-"*.tgz
cp "castika-streamlevel-$VER.tgz" "$SRC/"
cp yarn.lock "$SRC/yarn.lock"
echo "built in $BUILD"
ls -l "$SRC/castika-streamlevel-$VER.tgz"
