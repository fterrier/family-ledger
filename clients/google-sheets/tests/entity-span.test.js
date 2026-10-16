const test = require('node:test');
const assert = require('node:assert/strict');

const { loadCode, makeRowStoreSheet_ } = require('./_harness');

// --- resolveEntitySpan_ ---
// Spans captured earlier (sidebar open, multi-select tick, before an API round-trip)
// go stale when rows are inserted/removed above the entity. resolveEntitySpan_ must
// return where the entity lives *now*, cheaply when the hint is still accurate.

function txRow(name) {
  return { resource_name: name, transaction_date: '2026-01-01', payee: 'P' };
}

function makeEnv(names) {
  const rowStore = new Map(names.map((name, i) => [i + 2, txRow(name)]));
  const operations = [];
  const { sandbox } = loadCode();
  const sheet = makeRowStoreSheet_(sandbox, rowStore, operations);
  const sheetConfig = sandbox.getSheetConfigByName_('Transactions');
  return { sandbox, sheet, sheetConfig, operations };
}

test('resolveEntitySpan_ returns the hint when it still matches, with only a local read', () => {
  const { sandbox, sheet, sheetConfig, operations } = makeEnv([
    'transactions/a', 'transactions/b', 'transactions/b', 'transactions/c', 'transactions/d', 'transactions/e',
  ]);

  const span = sandbox.resolveEntitySpan_(sheet, sheetConfig, 'transactions/b', { start: 3, count: 2 });

  assert.deepEqual({ ...span }, { start: 3, count: 2 });
  const reads = operations.filter(op => op.type === 'getValues');
  assert.ok(reads.length > 0, 'verifies the hint against the sheet');
  reads.forEach(op => assert.ok(op.numRows <= 4, 'reads only the span plus its neighbours, got ' + op.numRows));
});

test('resolveEntitySpan_ relocates the entity when rows shifted above it', () => {
  const { sandbox, sheet, sheetConfig } = makeEnv([
    'transactions/new', 'transactions/a', 'transactions/b', 'transactions/b', 'transactions/c',
  ]);

  const span = sandbox.resolveEntitySpan_(sheet, sheetConfig, 'transactions/b', { start: 3, count: 2 });

  assert.deepEqual({ ...span }, { start: 4, count: 2 });
});

test('resolveEntitySpan_ returns the full span when the entity grew past the hint', () => {
  const { sandbox, sheet, sheetConfig } = makeEnv([
    'transactions/a', 'transactions/b', 'transactions/b', 'transactions/b', 'transactions/c',
  ]);

  const span = sandbox.resolveEntitySpan_(sheet, sheetConfig, 'transactions/b', { start: 3, count: 2 });

  assert.deepEqual({ ...span }, { start: 3, count: 3 });
});

test('resolveEntitySpan_ returns the full span when the entity shrank inside the hint', () => {
  const { sandbox, sheet, sheetConfig } = makeEnv([
    'transactions/a', 'transactions/b', 'transactions/c', 'transactions/d',
  ]);

  const span = sandbox.resolveEntitySpan_(sheet, sheetConfig, 'transactions/b', { start: 3, count: 2 });

  assert.deepEqual({ ...span }, { start: 3, count: 1 });
});

test('resolveEntitySpan_ handles a hint at the last row of the sheet', () => {
  const { sandbox, sheet, sheetConfig } = makeEnv(['transactions/a', 'transactions/b']);

  const span = sandbox.resolveEntitySpan_(sheet, sheetConfig, 'transactions/b', { start: 3, count: 1 });

  assert.deepEqual({ ...span }, { start: 3, count: 1 });
});

test('resolveEntitySpan_ relocates when the hint runs past the end of the sheet', () => {
  const { sandbox, sheet, sheetConfig } = makeEnv(['transactions/b', 'transactions/a']);

  const span = sandbox.resolveEntitySpan_(sheet, sheetConfig, 'transactions/b', { start: 3, count: 2 });

  assert.deepEqual({ ...span }, { start: 2, count: 1 });
});

test('resolveEntitySpan_ returns null when the entity is no longer on the sheet', () => {
  const { sandbox, sheet, sheetConfig } = makeEnv(['transactions/a', 'transactions/c']);

  assert.equal(sandbox.resolveEntitySpan_(sheet, sheetConfig, 'transactions/b', { start: 3, count: 1 }), null);
});

test('resolveEntitySpan_ returns null on an empty sheet', () => {
  const { sandbox, sheet, sheetConfig } = makeEnv([]);

  assert.equal(sandbox.resolveEntitySpan_(sheet, sheetConfig, 'transactions/b', { start: 2, count: 1 }), null);
});
