#!/usr/bin/env node
/*
 * Hard Node version gate.
 *
 * Deliberately written in ES5-compatible syntax with no static imports: an
 * unsupported Node must reach the message below instead of failing to parse the
 * bundle. The bundle is loaded lazily, after the check passes.
 *
 * MIN_NODE is duplicated from src/util/node.ts on purpose; test/node.test.ts
 * asserts that this literal, that module and package.json `engines` agree.
 */
'use strict';

var MIN_NODE = '20.19.0';

function parse(version) {
  var match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version));
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function satisfies(current, minimum) {
  var a = parse(current);
  var b = parse(minimum);
  if (!a || !b) return true;
  for (var i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

if (!satisfies(process.versions.node, MIN_NODE)) {
  process.stderr.write(
    'create-clientkit requires Node.js ' +
      MIN_NODE +
      ' or newer, but found ' +
      process.versions.node +
      '.\n' +
      '  Upgrade Node.js, or use a version manager such as nvm or fnm.\n',
  );
  process.exit(1);
}

import('../dist/cli.js').then(
  function (module) {
    return module.run();
  },
  function (error) {
    process.stderr.write('create-clientkit failed to start: ' + (error && error.message) + '\n');
    process.exit(1);
  },
);
