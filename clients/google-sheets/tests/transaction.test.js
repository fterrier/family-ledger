const test = require('node:test');
const assert = require('node:assert/strict');

const { loadCode, sampleTransaction } = require('./_harness');

function getTransaction(sandbox) {
  return sandbox.ENTITY_REGISTRY['Transactions'];
}

function loadT_() {
  const { sandbox } = loadCode();
  return { sandbox, Transaction: getTransaction(sandbox) };
}

// --- classifySupportedTransaction_ ---

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

// --- flattenTransactionForSheet_ ---

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

test('flattenTransactionForSheet_ passes transaction_date string through unchanged', () => {
  const { sandbox } = loadCode();
  const rows = sandbox.flattenTransactionForSheet_(sampleTransaction(), {
    'accounts/source': '[A] Bank - Checking',
    'accounts/food': '[X] Food',
  });
  assert.equal(rows[0].transaction_date, '2026-04-19');
});

// --- buildTransactionPatchPayload_ ---

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

// --- Transaction.fromRows() — success cases ---

const ACCOUNT_LOOKUP = {
  accountDisplayNameToResource: {
    '[A] Checking': 'accounts/checking',
    '[X] Food': 'accounts/food',
    '[X] Household': 'accounts/household',
    '[I] Salary': 'accounts/salary',
    '[A] Savings': 'accounts/savings',
  },
  accountResourceToDisplayName: {
    'accounts/checking': '[A] Checking',
    'accounts/food': '[X] Food',
    'accounts/household': '[X] Household',
    'accounts/salary': '[I] Salary',
    'accounts/savings': '[A] Savings',
  },
};

test('Transaction.fromRows() single destination row builds correct postings', () => {
  const { Transaction } = loadT_();
  const rows = [{
    resource_name: 'transactions/txn_1',
    transaction_date: '2026-04-19',
    payee: 'Migros',
    narration: 'Groceries',
    narration_source: 'txn',
    source_account_name: '[A] Checking',
    destination_account_name: '[X] Food',
    amount: 84.25,
    symbol: 'CHF',
    __rowNumber: 2,
  }];

  const entity = Transaction.fromRows(rows, ACCOUNT_LOOKUP, { start: 2, count: 1 });
  const payload = entity.toApiPayload_();

  assert.equal(entity.getName(), 'transactions/txn_1');
  assert.deepEqual(JSON.parse(JSON.stringify(entity._span)), { start: 2, count: 1 });
  assert.equal(payload.transaction_date, '2026-04-19');
  assert.equal(payload.payee, 'Migros');
  assert.deepEqual(JSON.parse(JSON.stringify(payload.postings)), [
    { account: 'accounts/checking', units: { amount: '-84.25', symbol: 'CHF' } },
    { account: 'accounts/food', narration: null, units: { amount: '84.25', symbol: 'CHF' } },
  ]);
});

test('Transaction.fromRows() split rows (2 destinations) builds source + 2 destination postings', () => {
  const { Transaction } = loadT_();
  const rows = [
    {
      resource_name: 'transactions/txn_1',
      transaction_date: '2026-04-19',
      payee: 'Migros',
      narration: 'Groceries',
      narration_source: 'txn',
      source_account_name: '[A] Checking',
      destination_account_name: '[X] Food',
      amount: 50,
      symbol: 'CHF',
      __rowNumber: 2,
    },
    {
      resource_name: 'transactions/txn_1',
      transaction_date: '2026-04-19',
      payee: 'Migros',
      narration: 'Groceries',
      narration_source: 'txn',
      source_account_name: '[A] Checking',
      destination_account_name: '[X] Household',
      amount: 34.25,
      symbol: 'CHF',
      __rowNumber: 3,
    },
  ];

  const entity = Transaction.fromRows(rows, ACCOUNT_LOOKUP, { start: 2, count: 2 });
  const payload = entity.toApiPayload_();

  assert.equal(payload.postings.length, 3);
  assert.equal(payload.postings[0].account, 'accounts/checking');
  assert.equal(payload.postings[0].units.amount, '-84.25');
  assert.equal(payload.postings[1].account, 'accounts/food');
  assert.equal(payload.postings[2].account, 'accounts/household');
});

test('Transaction.fromRows() source-only row builds single source posting', () => {
  const { Transaction } = loadT_();
  const rows = [{
    resource_name: 'transactions/txn_1',
    transaction_date: '2025-12-31',
    payee: '',
    narration: 'Interest',
    narration_source: 'txn',
    source_account_name: '[A] Checking',
    destination_account_name: '',
    amount: 1.5,
    symbol: 'CHF',
    __rowNumber: 2,
  }];

  const entity = Transaction.fromRows(rows, ACCOUNT_LOOKUP, { start: 2, count: 1 });
  const payload = entity.toApiPayload_();

  assert.equal(payload.postings.length, 1);
  assert.equal(payload.postings[0].account, 'accounts/checking');
  assert.equal(payload.postings[0].units.amount, '-1.5');
});

test('Transaction.fromRows() span is stored and getName() returns resource_name', () => {
  const { Transaction } = loadT_();
  const rows = [{
    resource_name: 'transactions/txn_42',
    transaction_date: '2026-04-19',
    payee: 'Test',
    narration: 'Test',
    narration_source: 'txn',
    source_account_name: '[A] Checking',
    destination_account_name: '[X] Food',
    amount: 10,
    symbol: 'CHF',
    __rowNumber: 7,
  }];

  const entity = Transaction.fromRows(rows, ACCOUNT_LOOKUP, { start: 7, count: 1 });

  assert.deepEqual(JSON.parse(JSON.stringify(entity._span)), { start: 7, count: 1 });
  assert.equal(entity.getName(), 'transactions/txn_42');
});

// --- Transaction.fromRows() — error cases ---

test('Transaction.fromRows() throws on missing source account', () => {
  const { Transaction } = loadT_();

  assert.throws(() => Transaction.fromRows([{
    resource_name: 'transactions/txn_1',
    transaction_date: '2026-04-19',
    payee: 'Migros',
    narration: 'Groceries',
    narration_source: 'txn',
    source_account_name: '',
    destination_account_name: '[X] Food',
    amount: 84.25,
    symbol: 'CHF',
    __rowNumber: 2,
  // Empty source account: lookup fails before issues array is checked, so "Unknown account_name"
  }], ACCOUNT_LOOKUP, { start: 2, count: 1 }), /Unknown account_name/);
});

test('Transaction.fromRows() throws on inconsistent source account across rows', () => {
  const { Transaction } = loadT_();

  // Inconsistent source: requireSingleNormalizedValue_ returns '' → lookup throws "Unknown account_name"
  assert.throws(() => Transaction.fromRows([
    {
      resource_name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: 'Test', narration: 'Test',
      narration_source: 'txn', source_account_name: '[A] Checking', destination_account_name: '[X] Food',
      amount: 50, symbol: 'CHF', __rowNumber: 2,
    },
    {
      resource_name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: 'Test', narration: 'Test',
      narration_source: 'txn', source_account_name: '[A] Savings', destination_account_name: '[X] Household',
      amount: 34.25, symbol: 'CHF', __rowNumber: 3,
    },
  ], ACCOUNT_LOOKUP, { start: 2, count: 2 }), /Unknown account_name/);
});

test('Transaction.fromRows() throws on missing symbol', () => {
  const { Transaction } = loadT_();

  assert.throws(() => Transaction.fromRows([{
    resource_name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: 'Test', narration: 'Test',
    narration_source: 'txn', source_account_name: '[A] Checking', destination_account_name: '[X] Food',
    amount: 10, symbol: '', __rowNumber: 2,
  }], ACCOUNT_LOOKUP, { start: 2, count: 1 }), /Missing symbol/);
});

test('Transaction.fromRows() throws on inconsistent symbol across rows', () => {
  const { Transaction } = loadT_();

  assert.throws(() => Transaction.fromRows([
    {
      resource_name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: 'Test', narration: 'Test',
      narration_source: 'txn', source_account_name: '[A] Checking', destination_account_name: '[X] Food',
      amount: 50, symbol: 'CHF', __rowNumber: 2,
    },
    {
      resource_name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: 'Test', narration: 'Test',
      narration_source: 'txn', source_account_name: '[A] Checking', destination_account_name: '[X] Household',
      amount: 34.25, symbol: 'USD', __rowNumber: 3,
    },
  ], ACCOUNT_LOOKUP, { start: 2, count: 2 }), /Inconsistent symbol/);
});

test('Transaction.fromRows() throws on missing transaction_date', () => {
  const { Transaction } = loadT_();

  assert.throws(() => Transaction.fromRows([{
    resource_name: 'transactions/txn_1', transaction_date: '', payee: 'Test', narration: 'Test',
    narration_source: 'txn', source_account_name: '[A] Checking', destination_account_name: '[X] Food',
    amount: 10, symbol: 'CHF', __rowNumber: 2,
  }], ACCOUNT_LOOKUP, { start: 2, count: 1 }), /Missing transaction date/);
});

test('Transaction.fromRows() throws on inconsistent transaction_date across rows', () => {
  const { Transaction } = loadT_();

  assert.throws(() => Transaction.fromRows([
    {
      resource_name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: 'Test', narration: 'Test',
      narration_source: 'txn', source_account_name: '[A] Checking', destination_account_name: '[X] Food',
      amount: 50, symbol: 'CHF', __rowNumber: 2,
    },
    {
      resource_name: 'transactions/txn_1', transaction_date: '2026-04-20', payee: 'Test', narration: 'Test',
      narration_source: 'txn', source_account_name: '[A] Checking', destination_account_name: '[X] Household',
      amount: 34.25, symbol: 'CHF', __rowNumber: 3,
    },
  ], ACCOUNT_LOOKUP, { start: 2, count: 2 }), /Inconsistent transaction date/);
});

test('Transaction.fromRows() throws on unknown source account name', () => {
  const { Transaction } = loadT_();

  assert.throws(() => Transaction.fromRows([{
    resource_name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: 'Test', narration: 'Test',
    narration_source: 'txn', source_account_name: '[A] Unknown Account', destination_account_name: '[X] Food',
    amount: 10, symbol: 'CHF', __rowNumber: 2,
  }], ACCOUNT_LOOKUP, { start: 2, count: 1 }), /Unknown account_name/);
});

test('Transaction.fromRows() throws on unknown destination account name', () => {
  const { Transaction } = loadT_();

  assert.throws(() => Transaction.fromRows([{
    resource_name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: 'Test', narration: 'Test',
    narration_source: 'txn', source_account_name: '[A] Checking', destination_account_name: '[X] Unknown',
    amount: 10, symbol: 'CHF', __rowNumber: 2,
  }], ACCOUNT_LOOKUP, { start: 2, count: 1 }), /Unknown account_name/);
});

test('Transaction.fromRows() throws on mixed blank and non-blank destinations', () => {
  const { Transaction } = loadT_();

  assert.throws(() => Transaction.fromRows([
    {
      resource_name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: 'Test', narration: 'Test',
      narration_source: 'txn', source_account_name: '[A] Checking', destination_account_name: '',
      amount: 50, symbol: 'CHF', __rowNumber: 2,
    },
    {
      resource_name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: 'Test', narration: 'Test',
      narration_source: 'txn', source_account_name: '[A] Checking', destination_account_name: '[X] Food',
      amount: 34.25, symbol: 'CHF', __rowNumber: 3,
    },
  ], ACCOUNT_LOOKUP, { start: 2, count: 2 }), /must either all have destination accounts or all leave destination_account_name blank/);
});

test('Transaction.fromRows() throws when multiple rows have blank destinations', () => {
  const { Transaction } = loadT_();

  assert.throws(() => Transaction.fromRows([
    {
      resource_name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: 'Test', narration: 'Test',
      narration_source: 'txn', source_account_name: '[A] Checking', destination_account_name: '',
      amount: 50, symbol: 'CHF', __rowNumber: 2,
    },
    {
      resource_name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: 'Test', narration: 'Test',
      narration_source: 'txn', source_account_name: '[A] Checking', destination_account_name: '',
      amount: 34.25, symbol: 'CHF', __rowNumber: 3,
    },
  ], ACCOUNT_LOOKUP, { start: 2, count: 2 }), /source-only transaction can only have one visible row/);
});

test('Transaction.fromRows() throws on invalid (NaN) amount', () => {
  const { Transaction } = loadT_();

  assert.throws(() => Transaction.fromRows([{
    resource_name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: 'Test', narration: 'Test',
    narration_source: 'txn', source_account_name: '[A] Checking', destination_account_name: '[X] Food',
    amount: 'not-a-number', symbol: 'CHF', __rowNumber: 2,
  }], ACCOUNT_LOOKUP, { start: 2, count: 1 }), /invalid amount/);
});

test('Transaction.fromRows() throws when all rows are narration_source post', () => {
  const { Transaction } = loadT_();

  assert.throws(() => Transaction.fromRows([
    {
      resource_name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: 'Test', narration: 'A',
      narration_source: 'post', source_account_name: '[A] Checking', destination_account_name: '[X] Food',
      amount: 50, symbol: 'CHF', __rowNumber: 2,
    },
    {
      resource_name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: 'Test', narration: 'B',
      narration_source: 'post', source_account_name: '[A] Checking', destination_account_name: '[X] Household',
      amount: 34.25, symbol: 'CHF', __rowNumber: 3,
    },
  ], ACCOUNT_LOOKUP, { start: 2, count: 2 }), /At least one split row must keep the transaction narration/);
});

// --- Transaction.fromApi() ---

test('Transaction.fromApi() constructs entity with correct name and null span', () => {
  const { Transaction } = loadT_();

  const entity = Transaction.fromApi({
    name: 'transactions/txn_5',
    transaction_date: '2026-04-19',
    payee: 'Test',
    narration: 'Test',
    postings: [],
  }, ACCOUNT_LOOKUP);

  assert.equal(entity.getName(), 'transactions/txn_5');
  assert.equal(entity._span, null);
});

test('Transaction.fromApi() with null entity name returns null from getName()', () => {
  const { Transaction } = loadT_();

  const entity = Transaction.fromApi({ name: null, transaction_date: '2026-04-19', postings: [] }, ACCOUNT_LOOKUP);

  assert.equal(entity.getName(), null);
});

// --- Transaction.toApiPayload_() ---

test('Transaction.toApiPayload_() returns correct shape from internal API state', () => {
  const { Transaction } = loadT_();
  const api = {
    name: 'transactions/txn_1',
    transaction_date: '2026-04-19',
    payee: 'Migros',
    narration: 'Groceries',
    postings: [
      { account: 'accounts/checking', units: { amount: '-84.25', symbol: 'CHF' } },
      { account: 'accounts/food', units: { amount: '84.25', symbol: 'CHF' } },
    ],
  };
  const entity = Transaction.fromApi(api, ACCOUNT_LOOKUP);

  const payload = entity.toApiPayload_();

  assert.equal(payload.transaction_date, '2026-04-19');
  assert.equal(payload.payee, 'Migros');
  assert.equal(payload.narration, 'Groceries');
  assert.equal(payload.postings, api.postings);
  assert.equal('name' in payload, false);
});

test('Transaction.toApiPayload_() converts null payee/narration correctly', () => {
  const { Transaction } = loadT_();
  const entity = Transaction.fromApi({
    name: 'transactions/txn_1',
    transaction_date: '2026-04-19',
    payee: null,
    narration: null,
    postings: [],
  }, ACCOUNT_LOOKUP);

  const payload = entity.toApiPayload_();

  assert.equal(payload.payee, null);
  assert.equal(payload.narration, null);
});

// --- Transaction.setFields() ---

test('Transaction.setFields() updates transaction_date, payee, and narration', () => {
  const { Transaction } = loadT_();
  const entity = Transaction.fromApi({
    name: 'transactions/txn_1',
    transaction_date: '2026-04-19',
    payee: 'Old Payee',
    narration: 'Old narration',
    postings: [],
  }, ACCOUNT_LOOKUP);

  entity.setFields({ transaction_date: '2026-05-01', payee: 'New Payee', narration: 'New narration' });

  assert.equal(entity._api.transaction_date, '2026-05-01');
  assert.equal(entity._api.payee, 'New Payee');
  assert.equal(entity._api.narration, 'New narration');
});

test('Transaction.setFields() converts empty payee and narration to null', () => {
  const { Transaction } = loadT_();
  const entity = Transaction.fromApi({
    name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: 'Migros', narration: 'Groceries', postings: [],
  }, ACCOUNT_LOOKUP);

  entity.setFields({ payee: '', narration: '' });

  assert.equal(entity._api.payee, null);
  assert.equal(entity._api.narration, null);
});

test('Transaction.setFields() ignores unknown fields', () => {
  const { Transaction } = loadT_();
  const entity = Transaction.fromApi({
    name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: 'Migros', narration: 'Test', postings: [],
  }, ACCOUNT_LOOKUP);

  entity.setFields({ unknown_field: 'x', another_unknown: 42 });

  assert.equal(entity._api.unknown_field, undefined);
  assert.equal(entity._api.another_unknown, undefined);
  assert.equal(entity._api.payee, 'Migros');
});

// --- Transaction.validate() ---

test('Transaction.validate() throws when transaction_date is missing', () => {
  const { Transaction } = loadT_();
  const entity = Transaction.fromApi({
    name: 'transactions/txn_1', transaction_date: '', payee: null, narration: null, postings: [],
  }, ACCOUNT_LOOKUP);

  assert.throws(() => entity.validate(), /Transaction date is required/);
});

test('Transaction.validate() passes when transaction_date is present', () => {
  const { Transaction } = loadT_();
  const entity = Transaction.fromApi({
    name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: null, narration: null, postings: [],
  }, ACCOUNT_LOOKUP);

  assert.doesNotThrow(() => entity.validate());
});

// --- Transaction.isEditableHeader() ---

test('Transaction.isEditableHeader() returns true for editable headers', () => {
  const { Transaction } = loadT_();
  const editable = ['payee', 'narration', 'destination_account_name', 'amount', 'split_off_amount', 'edit'];
  editable.forEach(function(h) {
    assert.equal(Transaction.isEditableHeader(h), true, h + ' should be editable');
  });
});

test('Transaction.isEditableHeader() returns false for readonly and system headers', () => {
  const { Transaction } = loadT_();
  const nonEditable = ['resource_name', 'transaction_date', 'source_account_name', 'symbol', 'narration_source', 'issues', 'unknown'];
  nonEditable.forEach(function(h) {
    assert.equal(Transaction.isEditableHeader(h), false, h + ' should not be editable');
  });
});

// --- Static config ---

test('Transaction static config has correct values', () => {
  const { Transaction } = loadT_();

  assert.equal(Transaction.SHEET_KEY, 'transactions');
  assert.equal(Transaction.ENTITY_LABEL, 'transaction');
  assert.equal(Transaction.RESOURCE_IDENTITY.header, 'resource_name');
  assert.equal(Transaction.RESOURCE_IDENTITY.multiRow, true);
  assert.deepEqual(JSON.parse(JSON.stringify(Transaction.RESET_ON_SAVE_FIELDS)), ['split_off_amount']);
  assert.equal(Transaction.UPDATE_MASK, 'payee,narration,postings');
});

// --- flattenTransactionForSheet_ date round-trip ---

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
