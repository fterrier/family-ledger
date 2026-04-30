const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { CLIENT_DIR, SOURCE_FILES } = require('./_harness');

test('no duplicate const/let declarations across source files', () => {
  const identifierPattern = /^(?:const|let)\s+([A-Za-z_$][A-Za-z0-9_$]*)/;
  const seen = new Map();

  SOURCE_FILES.forEach((name) => {
    const lines = fs.readFileSync(path.join(CLIENT_DIR, name), 'utf8').split('\n');
    lines.forEach((line) => {
      const match = line.match(identifierPattern);
      if (!match) {
        return;
      }
      const identifier = match[1];
      assert.ok(
        !seen.has(identifier),
        `'${identifier}' declared in both '${seen.get(identifier)}' and '${name}'`
      );
      seen.set(identifier, name);
    });
  });
});
