const test = require('node:test');
const assert = require('node:assert/strict');

const { loadCode, sampleTransaction, makeRowStoreSheet_ } = require('./_harness');

test('findTransactionRowNumbersFromAnchor_ finds a single non-split row', () => {
  const { sandbox } = loadCode();
  const rowStore = new Map([
    [2, { resource_name: 'transactions/txn_a' }],
    [3, { resource_name: 'transactions/txn_b' }],
  ]);
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, []);
  const result = JSON.parse(JSON.stringify(sandbox.findTransactionRowNumbersFromAnchor_(fakeSheet, 2)));
  assert.deepEqual(result.span, { start: 2, count: 1 });
  assert.equal(result.transactionName, 'transactions/txn_a');
});

test('findTransactionRowNumbersFromAnchor_ finds split rows above and below anchor', () => {
  const { sandbox } = loadCode();
  const rowStore = new Map([
    [2, { resource_name: 'transactions/txn_1' }],
    [3, { resource_name: 'transactions/txn_1' }],
    [4, { resource_name: 'transactions/txn_1' }],
    [5, { resource_name: 'transactions/txn_2' }],
  ]);
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, []);
  const result = JSON.parse(JSON.stringify(sandbox.findTransactionRowNumbersFromAnchor_(fakeSheet, 3)));
  assert.deepEqual(result.span, { start: 2, count: 3 });
  assert.equal(result.transactionName, 'transactions/txn_1');
});

test('findTransactionRowNumbersFromAnchor_ finds split rows with anchor at top', () => {
  const { sandbox } = loadCode();
  const rowStore = new Map([
    [2, { resource_name: 'transactions/txn_1' }],
    [3, { resource_name: 'transactions/txn_1' }],
    [4, { resource_name: 'transactions/txn_2' }],
  ]);
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, []);
  const result = JSON.parse(JSON.stringify(sandbox.findTransactionRowNumbersFromAnchor_(fakeSheet, 2)));
  assert.deepEqual(result.span, { start: 2, count: 2 });
  assert.equal(result.transactionName, 'transactions/txn_1');
});

test('findTransactionRowNumbersFromAnchor_ finds split rows with anchor at bottom', () => {
  const { sandbox } = loadCode();
  const rowStore = new Map([
    [2, { resource_name: 'transactions/txn_0' }],
    [3, { resource_name: 'transactions/txn_1' }],
    [4, { resource_name: 'transactions/txn_1' }],
  ]);
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, []);
  const result = JSON.parse(JSON.stringify(sandbox.findTransactionRowNumbersFromAnchor_(fakeSheet, 4)));
  assert.deepEqual(result.span, { start: 3, count: 2 });
  assert.equal(result.transactionName, 'transactions/txn_1');
});

test('findTransactionRowNumbersFromAnchor_ throws when anchor row has no transaction', () => {
  const { sandbox } = loadCode();
  const rowStore = new Map([
    [2, { resource_name: 'transactions/txn_1' }],
    [3, { resource_name: '' }],
  ]);
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, []);
  assert.throws(() => sandbox.findTransactionRowNumbersFromAnchor_(fakeSheet, 3), /does not contain a transaction/);
});

// --- applyTransactionResponseToSheet_ ---

function makeReplacementRows_(sandbox, overrides = {}) {
  const rows = sandbox.flattenTransactionForSheet_(sampleTransaction(overrides.txn || {}), {
    'accounts/source': '[A] Bank - Checking',
    'accounts/food': '[X] Food',
  });
  rows.forEach(function(row) {
    row.split_off_amount = '';
  });
  return rows;
}

test('applyTransactionResponseToSheet_ inserts new transaction mid-sheet at date-sorted position', () => {
  const operations = [];
  const rowStore = new Map([
    [2, { resource_name: 'transactions/txn_a', transaction_date: '2026-04-19', payee: 'A' }],
    [3, { resource_name: 'transactions/txn_b', transaction_date: '2026-04-21', payee: 'B' }],
  ]);
  const { sandbox } = loadCode();
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, operations);
  const replacementRows = makeReplacementRows_(sandbox, { txn: { transaction_date: '2026-04-20', name: 'transactions/txn_new' } });

  const result = sandbox.applyTransactionResponseToSheet_(fakeSheet, null, replacementRows);

  assert.deepEqual(JSON.parse(JSON.stringify(result)), { start: 3, count: 1 });
  assert.equal(rowStore.get(3).resource_name, 'transactions/txn_new');
  assert.equal(rowStore.get(4).resource_name, 'transactions/txn_b');
});

test('applyTransactionResponseToSheet_ appends new transaction when date is after all existing', () => {
  const operations = [];
  const rowStore = new Map([
    [2, { resource_name: 'transactions/txn_a', transaction_date: '2026-04-19', payee: 'A' }],
  ]);
  const { sandbox } = loadCode();
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, operations);
  const replacementRows = makeReplacementRows_(sandbox, { txn: { transaction_date: '2026-04-25', name: 'transactions/txn_new' } });

  const result = sandbox.applyTransactionResponseToSheet_(fakeSheet, null, replacementRows);

  assert.deepEqual(JSON.parse(JSON.stringify(result)), { start: 3, count: 1 });
  assert.equal(rowStore.get(3).resource_name, 'transactions/txn_new');
});

test('applyTransactionResponseToSheet_ writes to row 2 when sheet is empty', () => {
  const operations = [];
  const rowStore = new Map();
  const { sandbox } = loadCode();
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, operations);
  const replacementRows = makeReplacementRows_(sandbox);

  const result = sandbox.applyTransactionResponseToSheet_(fakeSheet, null, replacementRows);

  // sampleTransaction has 1 destination → 1 row
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { start: 2, count: 1 });
  assert.equal(rowStore.get(2).resource_name, 'transactions/txn_1');
});

test('applyTransactionResponseToSheet_ deletes excess rows when posting count decreases', () => {
  // Two split rows → one merged row: row 3 should be deleted, row 4 shifts to 3
  const operations = [];
  const rowStore = new Map([
    [2, { resource_name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: 'Migros',
          narration: 'Groceries', source_account_name: '[A] Bank - Checking', destination_account_name: '[X] Food',
          amount: 50, symbol: 'CHF', split_off_amount: '', issues: '' }],
    [3, { resource_name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: 'Migros',
          narration: 'Groceries', source_account_name: '[A] Bank - Checking', destination_account_name: '[X] Household',
          amount: 34.25, symbol: 'CHF', split_off_amount: '', issues: '' }],
    [4, { resource_name: 'transactions/txn_other', transaction_date: '2026-04-21', payee: 'Other' }],
  ]);
  const { sandbox } = loadCode();
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, operations);
  // sampleTransaction has 1 destination → flattenTransactionForSheet_ returns 1 row
  const replacementRows = makeReplacementRows_(sandbox);

  const result = sandbox.applyTransactionResponseToSheet_(fakeSheet, { start: 2, count: 2 }, replacementRows);

  assert.deepEqual(JSON.parse(JSON.stringify(result)), { start: 2, count: 1 });
  assert.equal(rowStore.get(2).resource_name, 'transactions/txn_1');
  assert.equal(rowStore.get(3).resource_name, 'transactions/txn_other');
  const deleteOps = operations.filter(function(op) { return op.type === 'deleteRows'; });
  assert.equal(deleteOps.length, 1);
});

test('applyTransactionResponseToSheet_ inserts rows when posting count increases', () => {
  // One row → two split rows: a row should be inserted after row 2, row 3 shifts to 4
  const operations = [];
  const rowStore = new Map([
    [2, { resource_name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: 'Migros',
          narration: 'Groceries', source_account_name: '[A] Bank - Checking', destination_account_name: '[X] Food',
          amount: 84.25, symbol: 'CHF', split_off_amount: '', issues: '' }],
    [3, { resource_name: 'transactions/txn_other', transaction_date: '2026-04-21', payee: 'Other' }],
  ]);
  const { sandbox } = loadCode();
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, operations);
  // Use a 3-posting transaction (2 destinations) so flattenTransactionForSheet_ returns 2 rows
  const splitTxn = sampleTransaction({ postings: [
    { account: 'accounts/source', units: { amount: '-84.25', symbol: 'CHF' } },
    { account: 'accounts/food', units: { amount: '50', symbol: 'CHF' } },
    { account: 'accounts/household', units: { amount: '34.25', symbol: 'CHF' } },
  ]});
  const replacementRows = sandbox.flattenTransactionForSheet_(splitTxn, {
    'accounts/source': '[A] Bank - Checking',
    'accounts/food': '[X] Food',
    'accounts/household': '[X] Household',
  });
  replacementRows.forEach(function(row) { row.split_off_amount = ''; });

  const result = sandbox.applyTransactionResponseToSheet_(fakeSheet, { start: 2, count: 1 }, replacementRows);

  assert.deepEqual(JSON.parse(JSON.stringify(result)), { start: 2, count: 2 });
  assert.equal(rowStore.get(2).resource_name, 'transactions/txn_1');
  assert.equal(rowStore.get(3).resource_name, 'transactions/txn_1');
  assert.equal(rowStore.get(4).resource_name, 'transactions/txn_other');
  const insertOps = operations.filter(function(op) { return op.type === 'insertRowsAfter'; });
  assert.equal(insertOps.length, 1);
});

test('applyTransactionResponseToSheet_ does full setValues when same count and no existingRows', () => {
  const operations = [];
  const rowStore = new Map([
    [2, { resource_name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: 'Old Payee',
          narration: 'Groceries', source_account_name: '[A] Bank - Checking', destination_account_name: '[X] Food',
          amount: 84.25, symbol: 'CHF', split_off_amount: '', issues: '' }],
    [3, { resource_name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: 'Old Payee',
          narration: 'Groceries', source_account_name: '[A] Bank - Checking', destination_account_name: '',
          amount: -84.25, symbol: 'CHF', split_off_amount: '', issues: '' }],
  ]);
  const { sandbox } = loadCode();
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, operations);
  const replacementRows = makeReplacementRows_(sandbox);

  let setValuesCalled = false;
  sandbox.applyTransactionResponseToSheet_(fakeSheet, { start: 2, count: 2 }, replacementRows);

  assert.equal(rowStore.get(2).payee, 'Migros');
});
