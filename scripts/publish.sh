#!/bin/bash

# Clean unwanted context for publish
rm -rf meteor-core

# publish
npm install
meteor publish

# Revert meteor-core
git submodule update --init --recursive
