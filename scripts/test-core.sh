#!/bin/bash

# Prepare meteor-core
git submodule update --init --recursive

# Package name and directory
PACKAGE_NAME="reactive-publish"
PACKAGE_DIR_NAME="reactive-publish"
PACKAGE_PATH="meteor-core/packages/$PACKAGE_DIR_NAME"

# Create the package directory structure
echo "Creating package directory structure in meteor-core/packages"
mkdir -p "$PACKAGE_PATH/lib/ReactiveAsync"
mkdir -p "$PACKAGE_PATH/lib/ReactiveMongo"

# Copy package.js with api.versionsFrom, package name lines, and Package.onTest block commented out
echo "Copying package.js with api.versionsFrom, package name lines, and Package.onTest block commented out"
# First, comment out api.versionsFrom and name: lines
sed -e 's/api.versionsFrom/\/\/ api.versionsFrom/' -e 's/name: /\/\/ name: /' package.js > "$PACKAGE_PATH/package.js.tmp"
# Then, comment out the Package.onTest block with /* */ style comments
awk '{
  if ($0 ~ /Package.onTest/ && !in_block) {
    in_block = 1
    print "/*"
    print $0
  } else if (in_block && $0 ~ /\}\);/) {
    print $0
    print "*/"
    in_block = 0
  } else if (in_block) {
    print $0
  } else {
    print $0
  }
}' "$PACKAGE_PATH/package.js.tmp" > "$PACKAGE_PATH/package.js"
rm "$PACKAGE_PATH/package.js.tmp"

# Copy main.js
echo "Copying main.js"
cp main.js "$PACKAGE_PATH/"

# Copy lib files
echo "Copying lib files"
cp lib/ReactiveAsync/*.js "$PACKAGE_PATH/lib/ReactiveAsync/"
cp lib/ReactiveMongo/*.js "$PACKAGE_PATH/lib/ReactiveMongo/"
cp lib/ReactivePublishServer.js "$PACKAGE_PATH/lib/"
cp lib/ReactivePublish.tests.js "$PACKAGE_PATH/lib/"
cp lib/ReactivePublishVsNonReactive.tests.js "$PACKAGE_PATH/lib/"

# Add nachocodoner:reactive-publish to the tinytest package
echo "Adding $PACKAGE_NAME to tinytest package.js"
sed -i "/api.mainModule('tinytest_client.js'/i \ \ api.use('$PACKAGE_NAME');" meteor-core/packages/tinytest/package.js

if [[ ! -d "./meteor-core/dev_bundle" ]]; then
  # Prepare meteor-core
  echo "Running tests"
  ./meteor-core/meteor --get-ready
fi

if [[ ! -d "./meteor-core/dev_bundle/lib/node_modules/puppeteer" ]]; then
  # Install puppeteer
  echo "Install puppeteer"
  curPWD="${PWD}"
  cd ./meteor-core/dev_bundle/lib
  npm install puppeteer@23.6.0 -D
  cd "${curPWD}"
fi

# Modify puppeteer_runner.js to add protocolTimeout: 300_000 and additional args
echo "Adding protocolTimeout: 300_000 and additional args (--disable-dev-shm-usage, --disable-gpu, --no-first-run, --no-zygote) to puppeteer.launch in puppeteer_runner.js"
sed -i 's/headless: "new",/headless: "new",\n    protocolTimeout: 300_000,/' meteor-core/packages/test-in-console/puppeteer_runner.js
sed -i "s/'--disable-web-security',/'--disable-web-security',\n      '--disable-dev-shm-usage',\n      '--disable-gpu',\n      '--no-first-run',\n      '--no-zygote',/" meteor-core/packages/test-in-console/puppeteer_runner.js

# Test core
echo "Running tests"
./meteor-core/packages/test-in-console/run.sh

# Store the exit code of the test:core script
TEST_EXIT_CODE=$?

# Reset the changes to the puppeteer_runner.js and tinytest package.js files
echo "Reverting changes to puppeteer_runner.js and tinytest package.js"
cd meteor-core
git checkout -- packages/test-in-console/puppeteer_runner.js packages/tinytest/package.js
cd ..

# Remove the copied package files
echo "Removing copied package files"
rm -rf "$PACKAGE_PATH"

echo "Tests completed with exit code: $TEST_EXIT_CODE"
echo "Changes to packages/test-in-console/puppeteer_runner.js and packages/tinytest/package.js have been reverted."
echo "Copied package files have been removed."

# Exit with the same code as the test:core script
exit $TEST_EXIT_CODE
