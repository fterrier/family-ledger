const test = require('node:test');
const assert = require('node:assert/strict');

const { loadCode, sampleTransaction } = require('./_harness');

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
  assert.equal(rows[0].amount, 5524.65);
});

test('buildTransactionPatchPayloadFromGroup_ rebuilds canonical PATCH payload in sheet row order', () => {
  const { sandbox } = loadCode();

  const payload = sandbox.buildTransactionPatchPayloadFromGroup_({
    transactionName: 'transactions/txn_1',
    contiguous: true,
    rows: [
      {
        resource_name: 'transactions/txn_1', narration_source: 'txn', transaction_date: '2026-04-19',
        payee: 'Migros', narration: 'Groceries split', source_account_name: 'Assets:Bank:Checking',
        destination_account_name: 'Expenses:Household', amount: 34.25, symbol: 'CHF', __rowNumber: 4,
      },
      {
        resource_name: 'transactions/txn_1', narration_source: 'txn', transaction_date: '2026-04-19',
        payee: 'Migros', narration: 'Groceries split', source_account_name: 'Assets:Bank:Checking',
        destination_account_name: 'Expenses:Food', amount: 50, symbol: 'CHF', __rowNumber: 5,
      },
    ],
  }, {
    'Assets:Bank:Checking': 'accounts/source',
    'Expenses:Food': 'accounts/food',
    'Expenses:Household': 'accounts/household',
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

test('buildTransactionPatchPayloadFromGroup_ normalizes Sheets date objects to yyyy-mm-dd', () => {
  const { sandbox } = loadCode();
  const payload = sandbox.buildTransactionPatchPayloadFromGroup_({
    transactionName: 'transactions/txn_1',
    contiguous: true,
    rows: [{
      resource_name: 'transactions/txn_1', narration_source: 'txn', transaction_date: new Date('2019-09-15T22:00:00.000Z'),
      payee: 'Migros', narration: 'Groceries', source_account_name: 'Assets:Bank:Checking',
      destination_account_name: 'Expenses:Food', amount: 84.25, symbol: 'CHF', __rowNumber: 2,
    }],
  }, {
    'Assets:Bank:Checking': 'accounts/source',
    'Expenses:Food': 'accounts/food',
  });

  assert.equal(payload.transaction_date, '2019-09-15');
});

test('buildTransactionPatchPayloadFromGroup_ keeps transaction narration separate from posting narrations', () => {
  const { sandbox } = loadCode();
  const payload = sandbox.buildTransactionPatchPayloadFromGroup_({
    transactionName: 'transactions/txn_1',
    contiguous: true,
    rows: [
      {
        resource_name: 'transactions/txn_1', narration_source: 'post', transaction_date: '2026-04-19', payee: 'Migros',
        narration: 'A', source_account_name: 'Assets:Bank:Checking', destination_account_name: 'Expenses:Food',
        amount: 50, symbol: 'CHF', __rowNumber: 2,
      },
      {
        resource_name: 'transactions/txn_1', narration_source: 'txn', transaction_date: '2026-04-19', payee: 'Migros',
        narration: 'Shared', source_account_name: 'Assets:Bank:Checking', destination_account_name: 'Expenses:Household',
        amount: 34.25, symbol: 'CHF', __rowNumber: 3,
      },
    ],
  }, {
    'Assets:Bank:Checking': 'accounts/source',
    'Expenses:Food': 'accounts/food',
    'Expenses:Household': 'accounts/household',
  });

  assert.equal(payload.narration, 'Shared');
  assert.deepEqual(JSON.parse(JSON.stringify(payload.postings.slice(1))), [
    { account: 'accounts/food', narration: 'A', units: { amount: '50', symbol: 'CHF' } },
    { account: 'accounts/household', narration: null, units: { amount: '34.25', symbol: 'CHF' } },
  ]);
});

test('buildTransactionPatchPayloadFromGroup_ treats differing split row narration as posting narration even if source is txn', () => {
  const { sandbox } = loadCode();
  const payload = sandbox.buildTransactionPatchPayloadFromGroup_({
    transactionName: 'transactions/txn_1',
    contiguous: true,
    rows: [
      {
        resource_name: 'transactions/txn_1', narration_source: 'txn', transaction_date: '2026-04-19', payee: 'Migros',
        narration: 'Shared', source_account_name: 'Assets:Bank:Checking', destination_account_name: 'Expenses:Food',
        amount: 50, symbol: 'CHF', __rowNumber: 2,
      },
      {
        resource_name: 'transactions/txn_1', narration_source: 'txn', transaction_date: '2026-04-19', payee: 'Migros',
        narration: 'Household', source_account_name: 'Assets:Bank:Checking', destination_account_name: 'Expenses:Household',
        amount: 34.25, symbol: 'CHF', __rowNumber: 3,
      },
    ],
  }, {
    'Assets:Bank:Checking': 'accounts/source',
    'Expenses:Food': 'accounts/food',
    'Expenses:Household': 'accounts/household',
  });

  assert.equal(payload.narration, 'Shared');
  assert.deepEqual(JSON.parse(JSON.stringify(payload.postings.slice(1))), [
    { account: 'accounts/food', narration: null, units: { amount: '50', symbol: 'CHF' } },
    { account: 'accounts/household', narration: 'Household', units: { amount: '34.25', symbol: 'CHF' } },
  ]);
});

test('buildTransactionPatchPayloadFromGroup_ emits source-only transaction when destination is blank', () => {
  const { sandbox } = loadCode();
  const payload = sandbox.buildTransactionPatchPayloadFromGroup_({
    transactionName: 'transactions/txn_1',
    contiguous: true,
    rows: [{
      resource_name: 'transactions/txn_1', narration_source: 'txn', transaction_date: '2025-12-31', payee: '',
      narration: 'Guthabenzins: Guthabenzins', source_account_name: 'Assets:Bank:Checking', destination_account_name: '',
      amount: 1.5, symbol: 'CHF', __rowNumber: 2,
    }],
  }, {
    'Assets:Bank:Checking': 'accounts/source',
  });

  assert.deepEqual(JSON.parse(JSON.stringify(payload)), {
    transaction_date: '2025-12-31',
    payee: null,
    narration: 'Guthabenzins: Guthabenzins',
    postings: [{ account: 'accounts/source', units: { amount: '-1.5', symbol: 'CHF' } }],
  });
});

test('buildTransactionPatchPayloadFromGroup_ rejects mixed blank and non-blank destinations', () => {
  const { sandbox } = loadCode();

  assert.throws(() => sandbox.buildTransactionPatchPayloadFromGroup_({
    transactionName: 'transactions/txn_1',
    contiguous: true,
    rows: [
      { resource_name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: 'Migros', narration: 'Groceries', source_account_name: 'Assets:Bank:Checking', destination_account_name: '', amount: 50, symbol: 'CHF', __rowNumber: 2 },
      { resource_name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: 'Migros', narration: 'Groceries', source_account_name: 'Assets:Bank:Checking', destination_account_name: 'Expenses:Food', amount: 34.25, symbol: 'CHF', __rowNumber: 3 },
    ],
  }, {
    'Assets:Bank:Checking': 'accounts/source',
    'Expenses:Food': 'accounts/food',
  }), /must either all have destination accounts or all leave destination_account_name blank/);
});

test('buildTransactionPatchPayloadFromGroup_ accepts negative destination amounts for income rows', () => {
  const { sandbox } = loadCode();
  const payload = sandbox.buildTransactionPatchPayloadFromGroup_({
    transactionName: 'transactions/txn_income',
    contiguous: true,
    rows: [{
      resource_name: 'transactions/txn_income', narration_source: 'txn', transaction_date: '2026-01-31', payee: '',
      narration: 'Monthly salary', source_account_name: '[A] Bank', destination_account_name: '[I] Salary',
      amount: -5000, symbol: 'CHF', __rowNumber: 2,
    }],
  }, {
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

test('isContiguousRowNumbers_ identifies split and contiguous groups', () => {
  const { sandbox } = loadCode();
  assert.equal(sandbox.isContiguousRowNumbers_([2, 3, 4]), true);
  assert.equal(sandbox.isContiguousRowNumbers_([2, 4]), false);
});

test('findTransactionRowNumbersFromColumnValues_ maps transaction ids to sheet row numbers', () => {
  const { sandbox } = loadCode();
  assert.deepEqual(
    JSON.parse(JSON.stringify(sandbox.findTransactionRowNumbersFromColumnValues_(['transactions/a', 'transactions/b', 'transactions/a'], 'transactions/a'))),
    [2, 4]
  );
});

test('buildContiguousRowSpans_ groups scattered row numbers into deletion spans', () => {
  const { sandbox } = loadCode();
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.buildContiguousRowSpans_([9, 2, 3, 7, 8]))), [
    { start: 2, count: 2 },
    { start: 7, count: 3 },
  ]);
});

test('canUpdateTransactionRowsInPlace_ accepts same-shape replacement rows', () => {
  const { sandbox } = loadCode();
  assert.equal(sandbox.canUpdateTransactionRowsInPlace_([
    { resource_name: 'transactions/txn_1', source_account_name: 'Assets:Bank:Checking', symbol: 'CHF' },
  ], [
    { resource_name: 'transactions/txn_1', source_account_name: 'Assets:Bank:Checking', symbol: 'CHF' },
  ]), true);
});

test('canUpdateTransactionRowsInPlace_ rejects row count changes', () => {
  const { sandbox } = loadCode();
  assert.equal(sandbox.canUpdateTransactionRowsInPlace_([
    { resource_name: 'transactions/txn_1', source_account_name: 'Assets:Bank:Checking', symbol: 'CHF' },
  ], [
    { resource_name: 'transactions/txn_1', source_account_name: 'Assets:Bank:Checking', symbol: 'CHF' },
    { resource_name: 'transactions/txn_1', source_account_name: 'Assets:Bank:Checking', symbol: 'CHF' },
  ]), false);
});

test('areTransactionRowsEquivalentForRefresh_ ignores transient helper fields', () => {
  const { sandbox } = loadCode();
  assert.equal(sandbox.areTransactionRowsEquivalentForRefresh_([
    {
      resource_name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: 'Migros', narration: 'Groceries',
      source_account_name: 'Assets:Bank:Checking', destination_account_name: 'Expenses:Food', amount: 84.25,
      split_off_amount: '10', symbol: 'CHF', status: 'saving', last_error: 'temporary',
    },
  ], [
    {
      resource_name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: 'Migros', narration: 'Groceries',
      source_account_name: 'Assets:Bank:Checking', destination_account_name: 'Expenses:Food', amount: 84.25,
      split_off_amount: '', symbol: 'CHF', status: 'saved', last_error: '',
    },
  ]), true);
});

test('areTransactionRowsEquivalentForRefresh_ detects business-field differences', () => {
  const { sandbox } = loadCode();
  assert.equal(sandbox.areTransactionRowsEquivalentForRefresh_([
    {
      resource_name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: 'Migros', narration: 'Groceries',
      source_account_name: 'Assets:Bank:Checking', destination_account_name: 'Expenses:Food', amount: 84.25, symbol: 'CHF',
    },
  ], [
    {
      resource_name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: 'Migros', narration: 'Groceries',
      source_account_name: 'Assets:Bank:Checking', destination_account_name: 'Expenses:Household', amount: 84.25, symbol: 'CHF',
    },
  ]), false);
});

test('updateTransactionRowsInPlace_ writes only changed cells', () => {
  const operations = [];
  const { sandbox } = loadCode();
  const fakeSheet = {
    getRange(row, column) {
      return { setValue(value) { operations.push({ row, column, value }); } };
    },
  };

  sandbox.updateTransactionRowsInPlace_(fakeSheet, [2], [{
    resource_name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: 'Old', narration: 'Keep',
    source_account_name: 'Assets:Bank:Checking', destination_account_name: 'Expenses:Food', amount: 84.25,
    split_off_amount: '', symbol: 'CHF', status: 'saving', last_error: '',
  }], [{
    resource_name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: 'New', narration: 'Keep',
    source_account_name: 'Assets:Bank:Checking', destination_account_name: 'Expenses:Food', amount: 84.25,
    split_off_amount: '', symbol: 'CHF', status: 'saved', last_error: '',
  }]);

  assert.deepEqual(JSON.parse(JSON.stringify(operations)), [
    { row: 2, column: 3, value: 'New' },
    { row: 2, column: 11, value: 'saved' },
  ]);
});

test('flattenTransactionForSheet_ passes transaction_date string through unchanged', () => {
  const { sandbox } = loadCode();
  const rows = sandbox.flattenTransactionForSheet_(sampleTransaction(), {
    'accounts/source': 'Assets:Bank:Checking',
    'accounts/food': 'Expenses:Food',
  });
  assert.equal(rows[0].transaction_date, '2026-04-19');
});

test('flattenTransactionForSheet_ date round-trips back to yyyy-MM-dd for API payload', () => {
  const { sandbox } = loadCode();
  const rows = sandbox.flattenTransactionForSheet_(sampleTransaction(), {
    'accounts/source': 'Assets:Bank:Checking',
    'accounts/food': 'Expenses:Food',
  });
  const payload = sandbox.buildTransactionPatchPayloadFromGroup_({
    transactionName: 'transactions/txn_1',
    contiguous: true,
    rows: rows,
  }, {
    'Assets:Bank:Checking': 'accounts/source',
    'Expenses:Food': 'accounts/food',
  });

  assert.equal(payload.transaction_date, '2026-04-19');
});
