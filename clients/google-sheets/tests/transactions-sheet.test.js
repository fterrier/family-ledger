const test = require('node:test');
const assert = require('node:assert/strict');

const { loadCode, sampleTransaction, makeRowStoreSheet_ } = require('./_harness');

test('classifySupportedTransaction_ accepts simple outgoing transaction', () => {
  const { sandbox } = loadCode();

  const shape = sandbox.classifySupportedTransaction_(sampleTransaction());

  assert.deepEqual(JSON.parse(JSON.stringify(shape)), {
    sourceIndex: 0,
    destinationIndexes: [1],
    symbol: 'CHF',
  });
});

test('classifySupportedTransaction_ accepts zero postings', () => {
  const { sandbox } = loadCode();

  const shape = sandbox.classifySupportedTransaction_({ postings: [] });

  assert.deepEqual(JSON.parse(JSON.stringify(shape)), {
    sourceIndex: null,
    destinationIndexes: [],
    symbol: null,
  });
});

test('classifySupportedTransaction_ uses balance-sheet account as source for income transaction', () => {
  const { sandbox } = loadCode();

  const shape = sandbox.classifySupportedTransaction_({
    postings: [
      { account: 'accounts/salary', units: { amount: '-5000', symbol: 'CHF' }, cost: null, price: null },
      { account: 'accounts/bank', units: { amount: '5000', symbol: 'CHF' }, cost: null, price: null },
    ],
  }, {
    'accounts/salary': '[I] Salary',
    'accounts/bank': '[A] Bank',
  });

  assert.deepEqual(JSON.parse(JSON.stringify(shape)), {
    sourceIndex: 1,
    destinationIndexes: [0],
    symbol: 'CHF',
  });
});

test('classifySupportedTransaction_ accepts single positive balance-sheet posting', () => {
  const { sandbox } = loadCode();

  const shape = sandbox.classifySupportedTransaction_({
    postings: [{ account: 'accounts/savings', units: { amount: '5524.65', symbol: 'CHF' }, cost: null, price: null }],
  }, {
    'accounts/savings': '[A] Savings',
  });

  assert.deepEqual(JSON.parse(JSON.stringify(shape)), {
    sourceIndex: 0,
    destinationIndexes: [],
    symbol: 'CHF',
  });
});

test('classifySupportedTransaction_ prefers negative balance-sheet account as source for transfers', () => {
  const { sandbox } = loadCode();

  const shape = sandbox.classifySupportedTransaction_({
    postings: [
      { account: 'accounts/checking', units: { amount: '-100', symbol: 'CHF' }, cost: null, price: null },
      { account: 'accounts/savings', units: { amount: '100', symbol: 'CHF' }, cost: null, price: null },
    ],
  }, {
    'accounts/checking': '[A] Checking',
    'accounts/savings': '[A] Savings',
  });

  assert.deepEqual(JSON.parse(JSON.stringify(shape)), {
    sourceIndex: 0,
    destinationIndexes: [1],
    symbol: 'CHF',
  });
});

test('classifySupportedTransaction_ rejects two positive postings with no balance-sheet account', () => {
  const { sandbox } = loadCode();

  const shape = sandbox.classifySupportedTransaction_({
    postings: [
      { account: 'accounts/food', units: { amount: '50', symbol: 'CHF' }, cost: null, price: null },
      { account: 'accounts/household', units: { amount: '50', symbol: 'CHF' }, cost: null, price: null },
    ],
  }, {
    'accounts/food': '[X] Food',
    'accounts/household': '[X] Household',
  });

  assert.equal(shape, null);
});

test('classifySupportedTransaction_ rejects multiple negative source legs', () => {
  const { sandbox } = loadCode();

  const shape = sandbox.classifySupportedTransaction_(sampleTransaction({
    postings: [
      { account: 'accounts/source-one', units: { amount: '-10', symbol: 'CHF' }, cost: null, price: null },
      { account: 'accounts/source-two', units: { amount: '-20', symbol: 'CHF' }, cost: null, price: null },
      { account: 'accounts/food', units: { amount: '30', symbol: 'CHF' }, cost: null, price: null },
    ],
  }));

  assert.equal(shape, null);
});

test('classifySupportedTransaction_ accepts source-only transaction', () => {
  const { sandbox } = loadCode();

  const shape = sandbox.classifySupportedTransaction_({
    postings: [{ account: 'accounts/source', units: { amount: '-1.5', symbol: 'CHF' }, cost: null, price: null }],
  });

  assert.deepEqual(JSON.parse(JSON.stringify(shape)), {
    sourceIndex: 0,
    destinationIndexes: [],
    symbol: 'CHF',
  });
});

test('flattenTransactionForSheet_ preserves posting order for split transactions', () => {
  const { sandbox } = loadCode();

  const rows = sandbox.flattenTransactionForSheet_(sampleTransaction({
    postings: [
      { account: 'accounts/source', units: { amount: '-84.25', symbol: 'CHF' }, cost: null, price: null },
      { account: 'accounts/food', units: { amount: '50', symbol: 'CHF' }, cost: null, price: null },
      { account: 'accounts/household', units: { amount: '34.25', symbol: 'CHF' }, cost: null, price: null },
    ],
  }), {
    'accounts/source': 'Assets:Bank:Checking',
    'accounts/food': 'Expenses:Food',
    'accounts/household': 'Expenses:Household',
  });

  assert.equal(rows.length, 2);
  assert.equal(rows[0].destination_account_name, 'Expenses:Food');
  assert.equal(rows[1].destination_account_name, 'Expenses:Household');
  assert.equal(rows[0].split_off_amount, '');
  assert.equal(rows[0].narration_source, 'txn');
});

test('flattenTransactionForSheet_ prefers posting narration over transaction narration', () => {
  const { sandbox } = loadCode();

  const rows = sandbox.flattenTransactionForSheet_(sampleTransaction({
    postings: [
      { account: 'accounts/source', units: { amount: '-84.25', symbol: 'CHF' }, cost: null, price: null, narration: 'Card charge' },
      { account: 'accounts/food', units: { amount: '84.25', symbol: 'CHF' }, cost: null, price: null, narration: 'Produce' },
    ],
  }), {
    'accounts/source': 'Assets:Bank:Checking',
    'accounts/food': 'Expenses:Food',
  });

  assert.equal(rows[0].narration, 'Produce');
  assert.equal(rows[0].narration_source, 'post');
});

test('flattenTransactionForSheet_ renders source-only transactions as one blank-destination row', () => {
  const { sandbox } = loadCode();

  const rows = sandbox.flattenTransactionForSheet_({
    name: 'transactions/txn_1',
    transaction_date: '2025-12-31',
    payee: null,
    narration: 'Guthabenzins: Guthabenzins',
    postings: [{ account: 'accounts/source', units: { amount: '-1.5', symbol: 'CHF' }, cost: null, price: null }],
  }, {
    'accounts/source': 'Assets:Bank:Checking',
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].destination_account_name, '');
  assert.equal(rows[0].amount, 1.5);
});

test('flattenTransactionForSheet_ renders zero-posting transactions as a placeholder row', () => {
  const { sandbox } = loadCode();

  const rows = sandbox.flattenTransactionForSheet_({
    name: 'transactions/txn_empty',
    transaction_date: '2025-01-01',
    payee: '',
    narration: 'No postings yet',
    postings: [],
  }, {});

  assert.equal(rows.length, 1);
  assert.equal(rows[0].source_account_name, '');
  assert.equal(rows[0].destination_account_name, '');
  assert.equal(rows[0].amount, '');
  assert.equal(rows[0].symbol, '');
});

test('flattenTransactionForSheet_ uses balance-sheet account as source with negative destination for income', () => {
  const { sandbox } = loadCode();

  const rows = sandbox.flattenTransactionForSheet_({
    name: 'transactions/txn_1',
    transaction_date: '2026-01-31',
    payee: '',
    narration: 'Monthly salary',
    postings: [
      { account: 'accounts/salary', units: { amount: '-5000', symbol: 'CHF' }, cost: null, price: null },
      { account: 'accounts/bank', units: { amount: '5000', symbol: 'CHF' }, cost: null, price: null },
    ],
  }, {
    'accounts/salary': '[I] Salary',
    'accounts/bank': '[A] Bank',
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].source_account_name, '[A] Bank');
  assert.equal(rows[0].destination_account_name, '[I] Salary');
  assert.equal(rows[0].amount, -5000);
  assert.equal(rows[0].symbol, 'CHF');
});

test('flattenTransactionForSheet_ shows abs amount for source-only with positive balance-sheet posting', () => {
  const { sandbox } = loadCode();

  const rows = sandbox.flattenTransactionForSheet_({
    name: 'transactions/txn_1',
    transaction_date: '2025-03-18',
    payee: '',
    narration: 'Incomplete transfer',
    postings: [{ account: 'accounts/savings', units: { amount: '5524.65', symbol: 'CHF' }, cost: null, price: null }],
  }, {
    'accounts/savings': '[A] Savings',
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].source_account_name, '[A] Savings');
  assert.equal(rows[0].destination_account_name, '');
  assert.equal(rows[0].amount, -5524.65);
});

test('flattenTransactionForSheet_ keeps positive sheet amount for source-only negative backend posting', () => {
  const { sandbox } = loadCode();

  const rows = sandbox.flattenTransactionForSheet_({
    name: 'transactions/txn_1',
    transaction_date: '2025-03-18',
    payee: '',
    narration: 'Card charge',
    postings: [{ account: 'accounts/checking', units: { amount: '-1', symbol: 'CHF' }, cost: null, price: null }],
  }, {
    'accounts/checking': '[A] Checking',
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].source_account_name, '[A] Checking');
  assert.equal(rows[0].destination_account_name, '');
  assert.equal(rows[0].amount, 1);
});

test('buildTransactionPatchPayload_ rebuilds canonical PATCH payload in sheet row order', () => {
  const { sandbox } = loadCode();

  const payload = sandbox.buildTransactionPatchPayload_([
    {
      resource_name: 'transactions/txn_1', narration_source: 'txn', transaction_date: '2026-04-19',
      payee: 'Migros', narration: 'Groceries split', source_account_name: '[A] Bank - Checking',
      destination_account_name: '[X] Household', amount: 34.25, symbol: 'CHF', __rowNumber: 4,
    },
    {
      resource_name: 'transactions/txn_1', narration_source: 'txn', transaction_date: '2026-04-19',
      payee: 'Migros', narration: 'Groceries split', source_account_name: '[A] Bank - Checking',
      destination_account_name: '[X] Food', amount: 50, symbol: 'CHF', __rowNumber: 5,
    },
  ], {
    '[A] Bank - Checking': 'accounts/source',
    '[X] Food': 'accounts/food',
    '[X] Household': 'accounts/household',
  });

  assert.deepEqual(JSON.parse(JSON.stringify(payload)), {
    transaction_date: '2026-04-19',
    payee: 'Migros',
    narration: 'Groceries split',
    postings: [
      { account: 'accounts/source', units: { amount: '-84.25', symbol: 'CHF' } },
      { account: 'accounts/household', narration: null, units: { amount: '34.25', symbol: 'CHF' } },
      { account: 'accounts/food', narration: null, units: { amount: '50', symbol: 'CHF' } },
    ],
  });
});

test('buildTransactionPatchPayload_ normalizes Sheets date objects to yyyy-mm-dd', () => {
  const { sandbox } = loadCode();
  const payload = sandbox.buildTransactionPatchPayload_([{
    resource_name: 'transactions/txn_1', narration_source: 'txn', transaction_date: new Date('2019-09-15T22:00:00.000Z'),
    payee: 'Migros', narration: 'Groceries', source_account_name: '[A] Bank - Checking',
    destination_account_name: '[X] Food', amount: 84.25, symbol: 'CHF', __rowNumber: 2,
  }], {
    '[A] Bank - Checking': 'accounts/source',
    '[X] Food': 'accounts/food',
  });

  assert.equal(payload.transaction_date, '2019-09-15');
});

test('buildTransactionPatchPayload_ keeps transaction narration separate from posting narrations', () => {
  const { sandbox } = loadCode();
  const payload = sandbox.buildTransactionPatchPayload_([
    {
      resource_name: 'transactions/txn_1', narration_source: 'post', transaction_date: '2026-04-19', payee: 'Migros',
      narration: 'A', source_account_name: '[A] Bank - Checking', destination_account_name: '[X] Food',
      amount: 50, symbol: 'CHF', __rowNumber: 2,
    },
    {
      resource_name: 'transactions/txn_1', narration_source: 'txn', transaction_date: '2026-04-19', payee: 'Migros',
      narration: 'Shared', source_account_name: '[A] Bank - Checking', destination_account_name: '[X] Household',
      amount: 34.25, symbol: 'CHF', __rowNumber: 3,
    },
  ], {
    '[A] Bank - Checking': 'accounts/source',
    '[X] Food': 'accounts/food',
    '[X] Household': 'accounts/household',
  });

  assert.equal(payload.narration, 'Shared');
  assert.deepEqual(JSON.parse(JSON.stringify(payload.postings.slice(1))), [
    { account: 'accounts/food', narration: 'A', units: { amount: '50', symbol: 'CHF' } },
    { account: 'accounts/household', narration: null, units: { amount: '34.25', symbol: 'CHF' } },
  ]);
});

test('buildTransactionPatchPayload_ treats differing split row narration as posting narration even if source is txn', () => {
  const { sandbox } = loadCode();
  const payload = sandbox.buildTransactionPatchPayload_([
    {
      resource_name: 'transactions/txn_1', narration_source: 'txn', transaction_date: '2026-04-19', payee: 'Migros',
      narration: 'Shared', source_account_name: '[A] Bank - Checking', destination_account_name: '[X] Food',
      amount: 50, symbol: 'CHF', __rowNumber: 2,
    },
    {
      resource_name: 'transactions/txn_1', narration_source: 'txn', transaction_date: '2026-04-19', payee: 'Migros',
      narration: 'Household', source_account_name: '[A] Bank - Checking', destination_account_name: '[X] Household',
      amount: 34.25, symbol: 'CHF', __rowNumber: 3,
    },
  ], {
    '[A] Bank - Checking': 'accounts/source',
    '[X] Food': 'accounts/food',
    '[X] Household': 'accounts/household',
  });

  assert.equal(payload.narration, 'Shared');
  assert.deepEqual(JSON.parse(JSON.stringify(payload.postings.slice(1))), [
    { account: 'accounts/food', narration: null, units: { amount: '50', symbol: 'CHF' } },
    { account: 'accounts/household', narration: 'Household', units: { amount: '34.25', symbol: 'CHF' } },
  ]);
});

test('buildTransactionPatchPayload_ emits source-only transaction when destination is blank', () => {
  const { sandbox } = loadCode();
  const payload = sandbox.buildTransactionPatchPayload_([{
    resource_name: 'transactions/txn_1', narration_source: 'txn', transaction_date: '2025-12-31', payee: '',
    narration: 'Guthabenzins: Guthabenzins', source_account_name: '[A] Bank - Checking', destination_account_name: '',
    amount: 1.5, symbol: 'CHF', __rowNumber: 2,
  }], {
    '[A] Bank - Checking': 'accounts/source',
  });

  assert.deepEqual(JSON.parse(JSON.stringify(payload)), {
    transaction_date: '2025-12-31',
    payee: null,
    narration: 'Guthabenzins: Guthabenzins',
    postings: [{ account: 'accounts/source', units: { amount: '-1.5', symbol: 'CHF' } }],
  });
});

test('buildTransactionPatchPayload_ rejects mixed blank and non-blank destinations', () => {
  const { sandbox } = loadCode();

  assert.throws(() => sandbox.buildTransactionPatchPayload_([
    { resource_name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: 'Migros', narration: 'Groceries', source_account_name: '[A] Bank - Checking', destination_account_name: '', amount: 50, symbol: 'CHF', __rowNumber: 2 },
    { resource_name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: 'Migros', narration: 'Groceries', source_account_name: '[A] Bank - Checking', destination_account_name: '[X] Food', amount: 34.25, symbol: 'CHF', __rowNumber: 3 },
  ], {
    '[A] Bank - Checking': 'accounts/source',
    '[X] Food': 'accounts/food',
  }), /must either all have destination accounts or all leave destination_account_name blank/);
});

test('buildTransactionPatchPayload_ accepts negative destination amounts for income rows', () => {
  const { sandbox } = loadCode();
  const payload = sandbox.buildTransactionPatchPayload_([{
    resource_name: 'transactions/txn_income', narration_source: 'txn', transaction_date: '2026-01-31', payee: '',
    narration: 'Monthly salary', source_account_name: '[A] Bank', destination_account_name: '[I] Salary',
    amount: -5000, symbol: 'CHF', __rowNumber: 2,
  }], {
    '[A] Bank': 'accounts/bank',
    '[I] Salary': 'accounts/salary',
  });

  assert.deepEqual(JSON.parse(JSON.stringify(payload)), {
    transaction_date: '2026-01-31',
    payee: null,
    narration: 'Monthly salary',
    postings: [
      { account: 'accounts/bank', units: { amount: '5000', symbol: 'CHF' } },
      { account: 'accounts/salary', narration: null, units: { amount: '-5000', symbol: 'CHF' } },
    ],
  });
});

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

test('flattenTransactionForSheet_ passes transaction_date string through unchanged', () => {
  const { sandbox } = loadCode();
  const rows = sandbox.flattenTransactionForSheet_(sampleTransaction(), {
    'accounts/source': '[A] Bank - Checking',
    'accounts/food': '[X] Food',
  });
  assert.equal(rows[0].transaction_date, '2026-04-19');
});

// --- applyTransactionResponseToSheet_ ---

function makeReplacementRows_(sandbox, overrides = {}) {
  const rows = sandbox.flattenTransactionForSheet_(sampleTransaction(overrides.txn || {}), {
    'accounts/source': '[A] Bank - Checking',
    'accounts/food': '[X] Food',
  });
  rows.forEach(function(row) {
    row.split_off_amount = '';
    row.status = 'saved';
    row.last_error = '';
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
          amount: 50, symbol: 'CHF', status: 'saved', last_error: '', split_off_amount: '', issues: '' }],
    [3, { resource_name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: 'Migros',
          narration: 'Groceries', source_account_name: '[A] Bank - Checking', destination_account_name: '[X] Household',
          amount: 34.25, symbol: 'CHF', status: 'saved', last_error: '', split_off_amount: '', issues: '' }],
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
          amount: 84.25, symbol: 'CHF', status: 'saved', last_error: '', split_off_amount: '', issues: '' }],
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
  replacementRows.forEach(function(row) { row.split_off_amount = ''; row.status = 'saved'; row.last_error = ''; });

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
          amount: 84.25, symbol: 'CHF', status: 'dirty', last_error: '', split_off_amount: '', issues: '' }],
    [3, { resource_name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: 'Old Payee',
          narration: 'Groceries', source_account_name: '[A] Bank - Checking', destination_account_name: '',
          amount: -84.25, symbol: 'CHF', status: 'dirty', last_error: '', split_off_amount: '', issues: '' }],
  ]);
  const { sandbox } = loadCode();
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, operations);
  const replacementRows = makeReplacementRows_(sandbox);

  let setValuesCalled = false;
  sandbox.applyTransactionResponseToSheet_(fakeSheet, { start: 2, count: 2 }, replacementRows);

  assert.equal(rowStore.get(2).payee, 'Migros');
  assert.equal(rowStore.get(2).status, 'saved');
});

test('flattenTransactionForSheet_ date round-trips back to yyyy-MM-dd for API payload', () => {
  const { sandbox } = loadCode();
  const rows = sandbox.flattenTransactionForSheet_(sampleTransaction(), {
    'accounts/source': '[A] Bank - Checking',
    'accounts/food': '[X] Food',
  });
  const payload = sandbox.buildTransactionPatchPayload_(rows, {
    '[A] Bank - Checking': 'accounts/source',
    '[X] Food': 'accounts/food',
  });

  assert.equal(payload.transaction_date, '2026-04-19');
});
