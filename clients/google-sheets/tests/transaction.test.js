const test = require('node:test');
const assert = require('node:assert/strict');

const { loadCode, sampleTransaction, makeRowStoreSheet_ } = require('./_harness');

function getTransaction(sandbox) {
  return sandbox.ENTITY_REGISTRY['Transactions'];
}

function loadT_() {
  const { sandbox } = loadCode();
  return { sandbox, Transaction: getTransaction(sandbox) };
}

// --- classifyTransactionGroups_ ---

test('classifyTransactionGroups_ simple outgoing expense: negative [A] is source', () => {
  const { sandbox } = loadCode();

  const groups = sandbox.classifyTransactionGroups_(sampleTransaction(), {
    'accounts/source': '[A] Bank - Checking',
    'accounts/food': '[X] Food',
  });

  assert.equal(groups.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(groups[0])), {
    symbol: 'CHF', sourceIndex: 0, destinationIndexes: [1], hasCostPrice: false,
  });
});

test('classifyTransactionGroups_ returns empty array for zero postings', () => {
  const { sandbox } = loadCode();

  const groups = sandbox.classifyTransactionGroups_({ postings: [] });

  assert.deepEqual(JSON.parse(JSON.stringify(groups)), []);
});

test('classifyTransactionGroups_ income: negative [I] is source (rule 2), [A] bank is destination', () => {
  const { sandbox } = loadCode();

  const groups = sandbox.classifyTransactionGroups_({
    postings: [
      { account: 'accounts/salary', units: { amount: '-5000', symbol: 'CHF' }, cost: null, price: null },
      { account: 'accounts/bank', units: { amount: '5000', symbol: 'CHF' }, cost: null, price: null },
    ],
  }, {
    'accounts/salary': '[I] Salary',
    'accounts/bank': '[A] Bank',
  });

  assert.equal(groups.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(groups[0])), {
    symbol: 'CHF', sourceIndex: 0, destinationIndexes: [1], hasCostPrice: false,
  });
});

test('classifyTransactionGroups_ single positive [A] posting: rule 3 picks it as source', () => {
  const { sandbox } = loadCode();

  const groups = sandbox.classifyTransactionGroups_({
    postings: [{ account: 'accounts/savings', units: { amount: '5524.65', symbol: 'CHF' }, cost: null, price: null }],
  }, {
    'accounts/savings': '[A] Savings',
  });

  assert.equal(groups.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(groups[0])), {
    symbol: 'CHF', sourceIndex: 0, destinationIndexes: [], hasCostPrice: false,
  });
});

test('classifyTransactionGroups_ transfer: negative [A] preferred over positive [A]', () => {
  const { sandbox } = loadCode();

  const groups = sandbox.classifyTransactionGroups_({
    postings: [
      { account: 'accounts/checking', units: { amount: '-100', symbol: 'CHF' }, cost: null, price: null },
      { account: 'accounts/savings', units: { amount: '100', symbol: 'CHF' }, cost: null, price: null },
    ],
  }, {
    'accounts/checking': '[A] Checking',
    'accounts/savings': '[A] Savings',
  });

  assert.equal(groups.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(groups[0])), {
    symbol: 'CHF', sourceIndex: 0, destinationIndexes: [1], hasCostPrice: false,
  });
});

test('classifyTransactionGroups_ two [X] postings: first posting is source', () => {
  const { sandbox } = loadCode();

  const groups = sandbox.classifyTransactionGroups_({
    postings: [
      { account: 'accounts/food', units: { amount: '50', symbol: 'CHF' }, cost: null, price: null },
      { account: 'accounts/household', units: { amount: '50', symbol: 'CHF' }, cost: null, price: null },
    ],
  }, {
    'accounts/food': '[X] Food',
    'accounts/household': '[X] Household',
  });

  assert.equal(groups.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(groups[0])), {
    symbol: 'CHF', sourceIndex: 0, destinationIndexes: [1], hasCostPrice: false,
  });
});

test('classifyTransactionGroups_ multiple [X] legs: first posting is source', () => {
  const { sandbox } = loadCode();

  const groups = sandbox.classifyTransactionGroups_(sampleTransaction({
    postings: [
      { account: 'accounts/source-one', units: { amount: '-10', symbol: 'CHF' }, cost: null, price: null },
      { account: 'accounts/source-two', units: { amount: '-20', symbol: 'CHF' }, cost: null, price: null },
      { account: 'accounts/food', units: { amount: '30', symbol: 'CHF' }, cost: null, price: null },
    ],
  }));

  assert.equal(groups.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(groups[0])), {
    symbol: 'CHF', sourceIndex: 0, destinationIndexes: [1, 2], hasCostPrice: false,
  });
});

test('classifyTransactionGroups_ source-only: single negative picked by rule 4', () => {
  const { sandbox } = loadCode();

  const groups = sandbox.classifyTransactionGroups_({
    postings: [{ account: 'accounts/source', units: { amount: '-1.5', symbol: 'CHF' }, cost: null, price: null }],
  });

  assert.equal(groups.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(groups[0])), {
    symbol: 'CHF', sourceIndex: 0, destinationIndexes: [], hasCostPrice: false,
  });
});

test('classifyTransactionGroups_ investment buy with cost: hasCostPrice true, single group uses weight symbol', () => {
  const { sandbox } = loadCode();

  // VTI buy: pay CHF from bank, receive VTI shares at cost 200 USD each
  const groups = sandbox.classifyTransactionGroups_({
    postings: [
      {
        account: 'accounts/bank', units: { amount: '-1000', symbol: 'CHF' },
        weight: { amount: '-1000', symbol: 'CHF' }, cost: null, price: null,
      },
      {
        account: 'accounts/vti', units: { amount: '5', symbol: 'VTI' },
        weight: { amount: '1000', symbol: 'CHF' }, cost: { amount: '200', symbol: 'CHF' }, price: null,
      },
    ],
  }, {
    'accounts/bank': '[A] Bank',
    'accounts/vti': '[A] Investments - VTI',
  });

  assert.equal(groups.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(groups[0])), {
    symbol: 'CHF', sourceIndex: 0, destinationIndexes: [1], hasCostPrice: true,
  });
});

test('classifyTransactionGroups_ zero-weight posting is suppressed and not in any group', () => {
  const { sandbox } = loadCode();

  // A posting with weight amount 0 should be excluded
  const groups = sandbox.classifyTransactionGroups_({
    postings: [
      { account: 'accounts/bank', units: { amount: '-100', symbol: 'CHF' }, weight: { amount: '-100', symbol: 'CHF' }, cost: null, price: null },
      { account: 'accounts/food', units: { amount: '100', symbol: 'CHF' }, weight: { amount: '100', symbol: 'CHF' }, cost: null, price: null },
      { account: 'accounts/rounding', units: { amount: '0', symbol: 'CHF' }, weight: { amount: '0', symbol: 'CHF' }, cost: null, price: null },
    ],
  }, {
    'accounts/bank': '[A] Bank',
    'accounts/food': '[X] Food',
    'accounts/rounding': '[X] Rounding',
  });

  assert.equal(groups.length, 1);
  assert.equal(groups[0].destinationIndexes.length, 1);
  assert.equal(groups[0].destinationIndexes[0], 1);
});

test('classifyTransactionGroups_ FX conversion produces two groups (one per weight symbol)', () => {
  const { sandbox } = loadCode();

  // CHF out of bank, USD into USD account: two weight symbols → two groups
  const groups = sandbox.classifyTransactionGroups_({
    postings: [
      {
        account: 'accounts/chf_bank', units: { amount: '-900', symbol: 'CHF' },
        weight: { amount: '-900', symbol: 'CHF' }, cost: null, price: null,
      },
      {
        account: 'accounts/usd_account', units: { amount: '1000', symbol: 'USD' },
        weight: { amount: '1000', symbol: 'USD' }, cost: null, price: null,
      },
    ],
  }, {
    'accounts/chf_bank': '[A] Bank CHF',
    'accounts/usd_account': '[A] Bank USD',
  });

  assert.equal(groups.length, 2);
  assert.equal(groups[0].symbol, 'CHF');
  assert.equal(groups[0].sourceIndex, 0);
  assert.equal(groups[1].symbol, 'USD');
  assert.equal(groups[1].sourceIndex, 1);
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

test('flattenTransactionForSheet_ income: salary [I] is source, bank [A] is destination with positive amount', () => {
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
  assert.equal(rows[0].source_account_name, '[I] Salary');
  assert.equal(rows[0].destination_account_name, '[A] Bank');
  assert.equal(rows[0].amount, 5000);
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

test('flattenTransactionForSheet_ investment buy: uses weight for amount/symbol, hasCostPrice true', () => {
  const { sandbox } = loadCode();

  const rows = sandbox.flattenTransactionForSheet_({
    name: 'transactions/txn_buy',
    transaction_date: '2026-03-01',
    payee: 'IBKR',
    narration: 'VTI purchase',
    postings: [
      {
        account: 'accounts/bank', units: { amount: '-1000', symbol: 'CHF' },
        weight: { amount: '-1000', symbol: 'CHF' }, cost: null, price: null,
      },
      {
        account: 'accounts/vti', units: { amount: '5', symbol: 'VTI' },
        weight: { amount: '1000', symbol: 'CHF' }, cost: { amount: '200', symbol: 'CHF' }, price: null,
      },
    ],
  }, {
    'accounts/bank': '[A] Bank',
    'accounts/vti': '[A] Investments - VTI',
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].source_account_name, '[A] Bank');
  assert.equal(rows[0].destination_account_name, '[A] Investments - VTI');
  assert.equal(rows[0].amount, 1000);
  assert.equal(rows[0].symbol, 'CHF');
  assert.equal(rows[0].hasCostPrice, true);
});

test('flattenTransactionForSheet_ FX conversion: two rows, one per weight symbol', () => {
  const { sandbox } = loadCode();

  const rows = sandbox.flattenTransactionForSheet_({
    name: 'transactions/txn_fx',
    transaction_date: '2026-03-15',
    payee: '',
    narration: 'FX conversion',
    postings: [
      {
        account: 'accounts/chf_bank', units: { amount: '-900', symbol: 'CHF' },
        weight: { amount: '-900', symbol: 'CHF' }, cost: null, price: null,
      },
      {
        account: 'accounts/usd_account', units: { amount: '1000', symbol: 'USD' },
        weight: { amount: '1000', symbol: 'USD' }, cost: null, price: null,
      },
    ],
  }, {
    'accounts/chf_bank': '[A] Bank CHF',
    'accounts/usd_account': '[A] Bank USD',
  });

  assert.equal(rows.length, 2);
  assert.equal(rows[0].symbol, 'CHF');
  assert.equal(rows[0].source_account_name, '[A] Bank CHF');
  assert.equal(rows[0].amount, 900);
  // USD group has one posting (weight +1000), selected as source by rule 3.
  // Source-only amount = -(+1000) = -1000 (negative = inflow; sum by USD account gives -1000 net).
  assert.equal(rows[1].symbol, 'USD');
  assert.equal(rows[1].source_account_name, '[A] Bank USD');
  assert.equal(rows[1].amount, -1000);
});

test('flattenTransactionForSheet_ falls back to units when weight field absent (backward compat)', () => {
  const { sandbox } = loadCode();

  const rows = sandbox.flattenTransactionForSheet_(sampleTransaction(), {
    'accounts/source': '[A] Bank',
    'accounts/food': '[X] Food',
  });

  assert.equal(rows[0].amount, 84.25);
  assert.equal(rows[0].symbol, 'CHF');
});

test('flattenTransactionForSheet_ hasCostPrice false when no posting has cost or price', () => {
  const { sandbox } = loadCode();

  const rows = sandbox.flattenTransactionForSheet_(sampleTransaction(), {
    'accounts/source': '[A] Bank',
    'accounts/food': '[X] Food',
  });

  assert.equal(rows[0].hasCostPrice, false);
});

test('flattenTransactionForSheet_ unbalanced 2-posting: adds blank destination row for remainder', () => {
  const { sandbox } = loadCode();

  const rows = sandbox.flattenTransactionForSheet_({
    name: 'transactions/txn_1',
    transaction_date: '2026-04-19',
    payee: 'Shop',
    narration: 'Partial split',
    postings: [
      { account: 'accounts/checking', units: { amount: '-100', symbol: 'CHF' } },
      { account: 'accounts/food', units: { amount: '60', symbol: 'CHF' } },
    ],
  }, { 'accounts/checking': '[A] Checking', 'accounts/food': '[X] Food' });

  assert.equal(rows.length, 2);
  assert.equal(rows[0].destination_account_name, '[X] Food');
  assert.equal(rows[0].amount, 60);
  assert.equal(rows[1].destination_account_name, '');
  assert.equal(rows[1].amount, 40);
  assert.equal(rows[1].source_account_name, '[A] Checking');
  assert.equal(rows[1].symbol, 'CHF');
});

test('flattenTransactionForSheet_ balanced 2-posting transaction produces exactly 1 row', () => {
  const { sandbox } = loadCode();

  const rows = sandbox.flattenTransactionForSheet_({
    name: 'transactions/txn_1',
    transaction_date: '2026-04-19',
    payee: 'Shop',
    narration: 'Balanced',
    postings: [
      { account: 'accounts/checking', units: { amount: '-100', symbol: 'CHF' } },
      { account: 'accounts/food', units: { amount: '100', symbol: 'CHF' } },
    ],
  }, { 'accounts/checking': '[A] Checking', 'accounts/food': '[X] Food' });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].destination_account_name, '[X] Food');
});

test('flattenTransactionForSheet_ unbalanced 3-posting: adds blank destination row after the two explicit destinations', () => {
  const { sandbox } = loadCode();

  const rows = sandbox.flattenTransactionForSheet_({
    name: 'transactions/txn_1',
    transaction_date: '2026-04-19',
    payee: 'Shop',
    narration: 'Multi split unbalanced',
    postings: [
      { account: 'accounts/checking', units: { amount: '-100', symbol: 'CHF' } },
      { account: 'accounts/food', units: { amount: '40', symbol: 'CHF' } },
      { account: 'accounts/restaurant', units: { amount: '30', symbol: 'CHF' } },
    ],
  }, { 'accounts/checking': '[A] Checking', 'accounts/food': '[X] Food', 'accounts/restaurant': '[X] Restaurant' });

  assert.equal(rows.length, 3);
  assert.equal(rows[0].destination_account_name, '[X] Food');
  assert.equal(rows[0].amount, 40);
  assert.equal(rows[1].destination_account_name, '[X] Restaurant');
  assert.equal(rows[1].amount, 30);
  assert.equal(rows[2].destination_account_name, '');
  assert.equal(rows[2].amount, 30);
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

test('buildTransactionPatchPayload_ preserves transaction_date as-is', () => {
  const { sandbox } = loadCode();
  const payload = sandbox.buildTransactionPatchPayload_([{
    resource_name: 'transactions/txn_1', narration_source: 'txn', transaction_date: '2019-09-15',
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

test('buildTransactionPatchPayload_ emits null-account posting for single blank destination', () => {
  const { sandbox } = loadCode();
  const payload = sandbox.buildTransactionPatchPayload_([{
    resource_name: 'transactions/txn_1', narration_source: 'txn', transaction_date: '2025-12-31', payee: '',
    narration: 'Guthabenzins: Guthabenzins', source_account_name: '[A] Bank - Checking', destination_account_name: '',
    amount: 1.5, symbol: 'CHF', __rowNumber: 2,
  }], {
    '[A] Bank - Checking': 'accounts/source',
  });

  assert.equal(payload.postings.length, 2);
  assert.equal(payload.postings[0].account, 'accounts/source');
  assert.equal(payload.postings[0].units.amount, '-1.5');
  assert.equal(payload.postings[1].account, null);
  assert.equal(payload.postings[1].units.amount, '1.5');
});

test('buildTransactionPatchPayload_ preserves visual row order: blank row before categorized row', () => {
  const { sandbox } = loadCode();

  const payload = sandbox.buildTransactionPatchPayload_([
    { resource_name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: 'Migros', narration: 'Groceries', source_account_name: '[A] Bank - Checking', destination_account_name: '', amount: 50, symbol: 'CHF', __rowNumber: 2 },
    { resource_name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: 'Migros', narration: 'Groceries', source_account_name: '[A] Bank - Checking', destination_account_name: '[X] Food', amount: 34.25, symbol: 'CHF', __rowNumber: 3 },
  ], {
    '[A] Bank - Checking': 'accounts/source',
    '[X] Food': 'accounts/food',
  });

  assert.equal(payload.postings.length, 3);
  assert.equal(payload.postings[0].account, 'accounts/source');
  assert.equal(parseFloat(payload.postings[0].units.amount), -84.25);
  // Visual order preserved: blank row 2 is postings[1], categorized row 3 is postings[2]
  assert.equal(payload.postings[1].account, null);
  assert.equal(parseFloat(payload.postings[1].units.amount), 50);
  assert.equal(payload.postings[2].account, 'accounts/food');
  assert.equal(parseFloat(payload.postings[2].units.amount), 34.25);
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

test('Transaction.fromRows() with mixed blank and non-blank destinations builds null-account posting for blank row', () => {
  const { Transaction } = loadT_();

  const tx = Transaction.fromRows([
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
  ], ACCOUNT_LOOKUP, { start: 2, count: 2 });

  assert.equal(tx._api.postings.length, 3);
  assert.equal(tx._api.postings[0].account, 'accounts/checking');
  assert.equal(parseFloat(tx._api.postings[0].units.amount), -84.25);
  // Visual order preserved: blank row 2 → postings[1], categorized row 3 → postings[2]
  assert.equal(tx._api.postings[1].account, null);
  assert.equal(parseFloat(tx._api.postings[1].units.amount), 50);
  assert.equal(tx._api.postings[2].account, 'accounts/food');
});

test('Transaction.fromRows() with multiple blank-destination rows builds null-account postings', () => {
  const { Transaction } = loadT_();

  const tx = Transaction.fromRows([
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
  ], ACCOUNT_LOOKUP, { start: 2, count: 2 });

  assert.equal(tx._api.postings.length, 3);
  assert.equal(tx._api.postings[0].account, 'accounts/checking');
  assert.equal(parseFloat(tx._api.postings[0].units.amount), -84.25);
  assert.equal(tx._api.postings[1].account, null);
  assert.equal(parseFloat(tx._api.postings[1].units.amount), 50);
  assert.equal(tx._api.postings[2].account, null);
  assert.equal(parseFloat(tx._api.postings[2].units.amount), 34.25);
});

test('Transaction.fromRows() throws on invalid (NaN) amount', () => {
  const { Transaction } = loadT_();

  assert.throws(() => Transaction.fromRows([{
    resource_name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: 'Test', narration: 'Test',
    narration_source: 'txn', source_account_name: '[A] Checking', destination_account_name: '[X] Food',
    amount: 'not-a-number', symbol: 'CHF', __rowNumber: 2,
  }], ACCOUNT_LOOKUP, { start: 2, count: 1 }), /invalid amount/);
});

test('Transaction.fromRows() accepts all narration_source=post rows with null transaction narration', () => {
  // Valid state after user edits the last txn-narration row: all postings carry their own narration.
  const { Transaction } = loadT_();

  const tx = Transaction.fromRows([
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
  ], ACCOUNT_LOOKUP, { start: 2, count: 2 });

  assert.equal(tx._api.narration, null, 'transaction narration is null when all rows are posting-specific');
  assert.equal(tx._api.postings[1].narration, 'A');
  assert.equal(tx._api.postings[2].narration, 'B');
});

// --- Transaction.fromApi_() ---

test('Transaction.fromApi_() constructs entity with correct name and null span', () => {
  const { Transaction } = loadT_();

  const entity = Transaction.fromApi_({
    name: 'transactions/txn_5',
    transaction_date: '2026-04-19',
    payee: 'Test',
    narration: 'Test',
    postings: [],
  }, ACCOUNT_LOOKUP);

  assert.equal(entity.getName(), 'transactions/txn_5');
  assert.equal(entity._span, null);
});

test('Transaction.fromApi_() with null entity name returns null from getName()', () => {
  const { Transaction } = loadT_();

  const entity = Transaction.fromApi_({ name: null, transaction_date: '2026-04-19', postings: [] }, ACCOUNT_LOOKUP);

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
  const entity = Transaction.fromApi_(api, ACCOUNT_LOOKUP);

  const payload = entity.toApiPayload_();

  assert.equal(payload.transaction_date, '2026-04-19');
  assert.equal(payload.payee, 'Migros');
  assert.equal(payload.narration, 'Groceries');
  assert.deepEqual(JSON.parse(JSON.stringify(payload.postings)), JSON.parse(JSON.stringify(api.postings)));
  assert.equal('name' in payload, false);
});

test('Transaction.toApiPayload_() converts null payee/narration correctly', () => {
  const { Transaction } = loadT_();
  const entity = Transaction.fromApi_({
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

test('Transaction.save() with all-blank destinations calls API with source only and preserves null postings', () => {
  const { sandbox } = loadCode();
  const apiCalls = [];
  sandbox.apiFetchJson_ = function(method, path, payload) {
    apiCalls.push({ method, path, payload });
    const posted = payload.transaction;
    return { name: 'transactions/txn_1', transaction_date: posted.transaction_date, payee: null, narration: null, postings: posted.postings };
  };
  const props = {};
  sandbox.PropertiesService = { getDocumentProperties() { return { getProperty(k) { return props[k] || null; }, setProperty(k, v) { props[k] = v; } }; } };
  const tx = makeTx(sandbox, {
    name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: null, narration: null,
    postings: [
      { account: 'accounts/checking', units: { amount: '-84.25', symbol: 'CHF' } },
      { account: null, units: { amount: '50', symbol: 'CHF' } },
      { account: null, units: { amount: '34.25', symbol: 'CHF' } },
    ],
  }, { start: 2, count: 2 });
  const committed = [];
  tx._commitToSheet_ = function(sheet) { committed.push(sheet); return this._span; };

  tx.save({});

  assert.equal(apiCalls.length, 1, 'API called even when all destinations are blank');
  const sentPostings = apiCalls[0].payload.transaction.postings;
  assert.equal(sentPostings.length, 1, 'only source posting sent');
  assert.equal(tx._api.postings.length, 3, 'null postings preserved in _api after save');
  assert.equal(committed.length, 1, '_commitToSheet_ called after API');
});

test('Transaction.save() with mixed null and non-null destinations calls API and preserves null posting', () => {
  const { sandbox } = loadCode();
  const apiCalls = [];
  sandbox.apiFetchJson_ = function(method, path, payload) {
    apiCalls.push({ method, path, payload });
    const posted = payload.transaction;
    return { name: 'transactions/txn_1', transaction_date: posted.transaction_date, payee: null, narration: null, postings: posted.postings };
  };
  const props = {};
  sandbox.PropertiesService = { getDocumentProperties() { return { getProperty(k) { return props[k] || null; }, setProperty(k, v) { props[k] = v; } }; } };
  const tx = makeTx(sandbox, {
    name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: null, narration: null,
    postings: [
      { account: 'accounts/checking', units: { amount: '-84.25', symbol: 'CHF' } },
      { account: 'accounts/food', units: { amount: '50', symbol: 'CHF' } },
      { account: null, units: { amount: '34.25', symbol: 'CHF' } },
    ],
  }, { start: 2, count: 2 });
  const committed = [];
  tx._commitToSheet_ = function(sheet) { committed.push(sheet); return this._span; };

  tx.save({});

  assert.equal(apiCalls.length, 1, 'API called when at least one destination is set');
  const sentPostings = apiCalls[0].payload.transaction.postings;
  assert.equal(sentPostings.length, 2, 'null posting filtered before API call');
  assert.equal(sentPostings[1].account, 'accounts/food');
  assert.equal(tx._api.postings.length, 3, 'null posting preserved in _api after save');
  assert.equal(tx._api.postings[2].account, null);
  assert.equal(committed.length, 1, '_commitToSheet_ called after API');
});

test('Transaction.save() with single null-account destination calls API as source-only', () => {
  const { sandbox } = loadCode();
  const apiCalls = [];
  sandbox.apiFetchJson_ = function(method, path, payload) {
    apiCalls.push({ method, path, payload });
    const posted = payload.transaction;
    return { name: 'transactions/txn_1', transaction_date: posted.transaction_date, payee: null, narration: null, postings: posted.postings };
  };
  const props = {};
  sandbox.PropertiesService = { getDocumentProperties() { return { getProperty(k) { return props[k] || null; }, setProperty(k, v) { props[k] = v; } }; } };
  const tx = makeTx(sandbox, {
    name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: null, narration: null,
    postings: [
      { account: 'accounts/checking', units: { amount: '-84.25', symbol: 'CHF' } },
      { account: null, units: { amount: '84.25', symbol: 'CHF' } },
    ],
  }, { start: 2, count: 1 });
  const committed = [];
  tx._commitToSheet_ = function(sheet) { committed.push(sheet); return this._span; };

  tx.save({});

  assert.equal(apiCalls.length, 1, 'API called for single uncategorized row');
  const sentPostings = apiCalls[0].payload.transaction.postings;
  assert.equal(sentPostings.length, 1, 'only source posting sent');
  assert.equal(sentPostings[0].account, 'accounts/checking');
  assert.equal(tx._api.postings.length, 2, 'null posting preserved in _api after save');
  assert.equal(tx._api.postings[1].account, null);
  assert.equal(committed.length, 1, '_commitToSheet_ called after API');
});


test('Transaction.updateFromApi_() uses API response when no null-account postings', () => {
  const { Transaction } = loadT_();
  const entity = Transaction.fromApi_({
    name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: null, narration: null,
    postings: [
      { account: 'accounts/checking', units: { amount: '-84.25', symbol: 'CHF' } },
      { account: 'accounts/food', units: { amount: '84.25', symbol: 'CHF' } },
    ],
  }, ACCOUNT_LOOKUP);

  entity.updateFromApi_({
    name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: 'Updated', narration: null,
    postings: [
      { account: 'accounts/checking', units: { amount: '-84.25', symbol: 'CHF' } },
      { account: 'accounts/food', units: { amount: '84.25', symbol: 'CHF' } },
    ],
  });

  assert.equal(entity._api.payee, 'Updated');
  assert.equal(entity._api.postings.length, 2);
});

test('Transaction.updateFromApi_() re-attaches null-account postings after API response', () => {
  const { Transaction } = loadT_();
  const entity = Transaction.fromApi_({
    name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: null, narration: null,
    postings: [
      { account: 'accounts/checking', units: { amount: '-84.25', symbol: 'CHF' } },
      { account: 'accounts/food', units: { amount: '50', symbol: 'CHF' } },
      { account: null, units: { amount: '34.25', symbol: 'CHF' } },
    ],
  }, ACCOUNT_LOOKUP);

  entity.updateFromApi_({
    name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: 'Updated', narration: null,
    postings: [
      { account: 'accounts/checking', units: { amount: '-84.25', symbol: 'CHF' } },
      { account: 'accounts/food', units: { amount: '50', symbol: 'CHF' } },
    ],
  });

  assert.equal(entity._api.payee, 'Updated');
  assert.equal(entity._api.postings.length, 3, 'null posting re-attached');
  assert.equal(entity._api.postings[2].account, null);
  assert.equal(entity._api.postings[2].units.amount, '34.25');
});

test('Transaction.updateFromApi_() preserves original position of null posting between categorized rows', () => {
  const { Transaction } = loadT_();
  const entity = Transaction.fromApi_({
    name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: null, narration: null,
    postings: [
      { account: 'accounts/checking', units: { amount: '-84.25', symbol: 'CHF' } },
      { account: null, units: { amount: '34.25', symbol: 'CHF' } },
      { account: 'accounts/food', units: { amount: '50', symbol: 'CHF' } },
    ],
  }, ACCOUNT_LOOKUP);

  entity.updateFromApi_({
    name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: null, narration: null,
    postings: [
      { account: 'accounts/checking', units: { amount: '-50', symbol: 'CHF' } },
      { account: 'accounts/food', units: { amount: '50', symbol: 'CHF' } },
    ],
  });

  assert.equal(entity._api.postings.length, 3);
  assert.equal(entity._api.postings[1].account, null, 'null stays between source and food');
  assert.equal(entity._api.postings[1].units.amount, '34.25');
  assert.equal(entity._api.postings[2].account, 'accounts/food');
});

// --- Transaction.setFields() ---

test('Transaction.setFields() updates transaction_date, payee, and narration', () => {
  const { Transaction } = loadT_();
  const entity = Transaction.fromApi_({
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
  const entity = Transaction.fromApi_({
    name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: 'Migros', narration: 'Groceries', postings: [],
  }, ACCOUNT_LOOKUP);

  entity.setFields({ payee: '', narration: '' });

  assert.equal(entity._api.payee, null);
  assert.equal(entity._api.narration, null);
});

test('Transaction.setFields() ignores unknown fields', () => {
  const { Transaction } = loadT_();
  const entity = Transaction.fromApi_({
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
  const entity = Transaction.fromApi_({
    name: 'transactions/txn_1', transaction_date: '', payee: null, narration: null, postings: [],
  }, ACCOUNT_LOOKUP);

  assert.throws(() => entity.validate(), /Transaction date is required/);
});

test('Transaction.validate() passes when transaction_date is present', () => {
  const { Transaction } = loadT_();
  const entity = Transaction.fromApi_({
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
  assert.equal(Transaction.UPDATE_MASK, 'transaction_date,payee,narration,postings');
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

// --- scanEntityRows_(Transaction) ---

test('scanEntityRows_(Transaction) finds a single non-split row', () => {
  const { sandbox } = loadCode();
  const Transaction = sandbox.ENTITY_REGISTRY['Transactions'];
  const rowStore = new Map([
    [2, { resource_name: 'transactions/txn_a' }],
    [3, { resource_name: 'transactions/txn_b' }],
  ]);
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, []);
  const result = JSON.parse(JSON.stringify(sandbox.scanEntityRows_(Transaction, fakeSheet, 2)));
  assert.deepEqual(result.span, { start: 2, count: 1 });
  assert.equal(result.entityName, 'transactions/txn_a');
});

test('scanEntityRows_(Transaction) finds split rows above and below anchor', () => {
  const { sandbox } = loadCode();
  const Transaction = sandbox.ENTITY_REGISTRY['Transactions'];
  const rowStore = new Map([
    [2, { resource_name: 'transactions/txn_1' }],
    [3, { resource_name: 'transactions/txn_1' }],
    [4, { resource_name: 'transactions/txn_1' }],
    [5, { resource_name: 'transactions/txn_2' }],
  ]);
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, []);
  const result = JSON.parse(JSON.stringify(sandbox.scanEntityRows_(Transaction, fakeSheet, 3)));
  assert.deepEqual(result.span, { start: 2, count: 3 });
  assert.equal(result.entityName, 'transactions/txn_1');
});

test('scanEntityRows_(Transaction) finds split rows with anchor at top', () => {
  const { sandbox } = loadCode();
  const Transaction = sandbox.ENTITY_REGISTRY['Transactions'];
  const rowStore = new Map([
    [2, { resource_name: 'transactions/txn_1' }],
    [3, { resource_name: 'transactions/txn_1' }],
    [4, { resource_name: 'transactions/txn_2' }],
  ]);
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, []);
  const result = JSON.parse(JSON.stringify(sandbox.scanEntityRows_(Transaction, fakeSheet, 2)));
  assert.deepEqual(result.span, { start: 2, count: 2 });
  assert.equal(result.entityName, 'transactions/txn_1');
});

test('scanEntityRows_(Transaction) finds split rows with anchor at bottom', () => {
  const { sandbox } = loadCode();
  const Transaction = sandbox.ENTITY_REGISTRY['Transactions'];
  const rowStore = new Map([
    [2, { resource_name: 'transactions/txn_0' }],
    [3, { resource_name: 'transactions/txn_1' }],
    [4, { resource_name: 'transactions/txn_1' }],
  ]);
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, []);
  const result = JSON.parse(JSON.stringify(sandbox.scanEntityRows_(Transaction, fakeSheet, 4)));
  assert.deepEqual(result.span, { start: 3, count: 2 });
  assert.equal(result.entityName, 'transactions/txn_1');
});

test('scanEntityRows_(Transaction) throws when anchor row has no transaction', () => {
  const { sandbox } = loadCode();
  const Transaction = sandbox.ENTITY_REGISTRY['Transactions'];
  const rowStore = new Map([
    [2, { resource_name: 'transactions/txn_1' }],
    [3, { resource_name: '' }],
  ]);
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, []);
  assert.throws(() => sandbox.scanEntityRows_(Transaction, fakeSheet, 3), /does not contain a transaction/);
});

// --- Transaction.applyEdit ---

function makeTx(sandbox, api, span) {
  const Transaction = getTransaction(sandbox);
  const tx = new Transaction(api, {
    accountResourceToDisplayName: {
      'accounts/checking': '[A] Checking',
      'accounts/food': '[X] Food',
      'accounts/household': '[X] Household',
    },
    accountDisplayNameToResource: {
      '[A] Checking': 'accounts/checking',
      '[X] Food': 'accounts/food',
      '[X] Household': 'accounts/household',
    },
  });
  tx._span = span || { start: 2, count: 1 };
  return tx;
}

function singleDestApi(overrides) {
  return Object.assign({
    name: 'transactions/txn_1',
    transaction_date: '2026-04-19',
    payee: 'Migros',
    narration: 'Groceries',
    postings: [
      { account: 'accounts/checking', units: { amount: '-84.25', symbol: 'CHF' } },
      { account: 'accounts/food', units: { amount: '84.25', symbol: 'CHF' }, narration: null },
    ],
  }, overrides);
}

function splitApi() {
  return {
    name: 'transactions/txn_1',
    transaction_date: '2026-04-19',
    payee: 'Migros',
    narration: 'Groceries',
    postings: [
      { account: 'accounts/checking', units: { amount: '-84.25', symbol: 'CHF' } },
      { account: 'accounts/food', units: { amount: '50', symbol: 'CHF' }, narration: null },
      { account: 'accounts/household', units: { amount: '34.25', symbol: 'CHF' }, narration: null },
    ],
  };
}

// payee

test("Transaction.applyEdit('payee') updates api.payee", () => {
  const { sandbox } = loadCode();
  const tx = makeTx(sandbox, singleDestApi());
  tx.applyEdit('payee', 'Coop', '', 2);
  assert.equal(tx._api.payee, 'Coop');
});

test("Transaction.applyEdit('payee') converts empty to null", () => {
  const { sandbox } = loadCode();
  const tx = makeTx(sandbox, singleDestApi());
  tx.applyEdit('payee', '', '', 2);
  assert.equal(tx._api.payee, null);
});

// narration

test("Transaction.applyEdit('narration') single-row sets api.narration", () => {
  const { sandbox } = loadCode();
  const tx = makeTx(sandbox, singleDestApi());
  tx.applyEdit('narration', 'Updated', 'Groceries', 2);
  assert.equal(tx._api.narration, 'Updated');
});

test("Transaction.applyEdit('narration') single-row converts empty to null", () => {
  const { sandbox } = loadCode();
  const tx = makeTx(sandbox, singleDestApi());
  tx.applyEdit('narration', '', 'Groceries', 2);
  assert.equal(tx._api.narration, null);
});

test("Transaction.applyEdit('narration') split row sets posting narration", () => {
  const { sandbox } = loadCode();
  const tx = makeTx(sandbox, splitApi(), { start: 2, count: 2 });
  tx.applyEdit('narration', 'Household', 'Groceries', 3);
  assert.equal(tx._api.postings[2].narration, 'Household');
  assert.equal(tx._api.postings[1].narration, null);
});

test("Transaction.applyEdit('narration') split row reverts posting narration when value equals txn narration", () => {
  const { sandbox } = loadCode();
  const api = splitApi();
  api.postings[2].narration = 'Household goods';
  const tx = makeTx(sandbox, api, { start: 2, count: 2 });
  tx.applyEdit('narration', 'Groceries', 'Household goods', 3);
  assert.equal(tx._api.postings[2].narration, null);
});

test("Transaction.applyEdit('narration') split row reverts to null on empty value", () => {
  const { sandbox } = loadCode();
  const api = splitApi();
  api.postings[2].narration = 'Household goods';
  const tx = makeTx(sandbox, api, { start: 2, count: 2 });
  tx.applyEdit('narration', '', 'Household goods', 3);
  assert.equal(tx._api.postings[2].narration, null);
});

test("Transaction.applyEdit('narration') blanks txn narration when editing last null posting to a different value", () => {
  const { sandbox } = loadCode();
  const api = splitApi();
  api.postings[2].narration = 'Household goods';
  const tx = makeTx(sandbox, api, { start: 2, count: 2 });
  tx.applyEdit('narration', 'Produce', 'Groceries', 2);
  assert.equal(tx._api.narration, null, 'transaction narration must be blanked');
  assert.equal(tx._api.postings[1].narration, 'Produce', 'edited posting gets its own narration');
  assert.equal(tx._api.postings[2].narration, 'Household goods', 'other posting unchanged');
});

test("Transaction.applyEdit('narration') does not throw when other posting already has null", () => {
  const { sandbox } = loadCode();
  const api = splitApi();
  const tx = makeTx(sandbox, api, { start: 2, count: 2 });
  tx.applyEdit('narration', 'Produce', 'Groceries', 2);
  assert.equal(tx._api.postings[1].narration, 'Produce');
  assert.equal(tx._api.postings[2].narration, null);
});

// destination_account_name

test("Transaction.applyEdit('destination_account_name') updates posting account", () => {
  const { sandbox } = loadCode();
  const tx = makeTx(sandbox, singleDestApi());
  tx.applyEdit('destination_account_name', '[X] Household', '', 2);
  assert.equal(tx._api.postings[1].account, 'accounts/household');
});

test("Transaction.applyEdit('destination_account_name') throws on unknown account", () => {
  const { sandbox } = loadCode();
  const tx = makeTx(sandbox, singleDestApi());
  assert.throws(
    () => tx.applyEdit('destination_account_name', 'Unknown', '', 2),
    /Unknown account_name/
  );
});

test("Transaction.applyEdit('destination_account_name') blank value sets account to null", () => {
  const { sandbox } = loadCode();
  const tx = makeTx(sandbox, singleDestApi());
  tx.applyEdit('destination_account_name', '', '[X] Food', 2);
  assert.equal(tx._api.postings[1].account, null);
});

// amount

test("Transaction.applyEdit('amount') inserts split posting with leftover amount", () => {
  const { sandbox } = loadCode();
  const tx = makeTx(sandbox, singleDestApi());
  tx.applyEdit('amount', '50', '84.25', 2);
  assert.equal(tx._api.postings.length, 3);
  assert.equal(tx._api.postings[1].units.amount, '50');
  assert.equal(tx._api.postings[2].units.amount, '34.25');
  assert.equal(tx._api.postings[0].units.amount, '-84.25');
});

test("Transaction.applyEdit('amount') no-op when amounts are equal", () => {
  const { sandbox } = loadCode();
  const tx = makeTx(sandbox, singleDestApi());
  tx.applyEdit('amount', '84.25', '84.25', 2);
  assert.equal(tx._api.postings.length, 2);
});

test("Transaction.applyEdit('amount') treats numeric 0 as valid new amount", () => {
  const { sandbox } = loadCode();
  const tx = makeTx(sandbox, singleDestApi());
  tx.applyEdit('amount', 0, '84.25', 2);
  assert.equal(tx._api.postings.length, 3);
  assert.equal(tx._api.postings[1].units.amount, '0');
  assert.equal(tx._api.postings[2].units.amount, '84.25');
});

test("Transaction.applyEdit('amount') splits source-only transaction into two null-account postings", () => {
  const { sandbox } = loadCode();

  const tx = makeTx(sandbox, {
    name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: '', narration: 'Interest',
    postings: [
      { account: 'accounts/checking', units: { amount: '-1.5', symbol: 'CHF' } },
      { account: null, units: { amount: '1.5', symbol: 'CHF' } },
    ],
  });
  tx.applyEdit('amount', '1', '1.5', 2);
  assert.equal(tx._api.postings.length, 3);
  assert.equal(tx._api.postings[1].account, null);
  assert.equal(tx._api.postings[1].units.amount, '1');
  assert.equal(tx._api.postings[2].account, null);
  assert.equal(tx._api.postings[2].units.amount, '0.5');
  assert.equal(tx._api.postings[0].units.amount, '-1.5');
});

test("Transaction.applyEdit('destination_account_name') clearing on single-row transaction with null posting is a no-op", () => {
  const { sandbox } = loadCode();
  const tx = makeTx(sandbox, {
    name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: '', narration: 'Interest',
    postings: [
      { account: 'accounts/checking', units: { amount: '-50', symbol: 'CHF' } },
      { account: null, units: { amount: '50', symbol: 'CHF' } },
    ],
  }, { start: 2, count: 1 });
  tx.applyEdit('destination_account_name', '', '', 2);
  assert.equal(tx._api.postings.length, 2);
  assert.equal(tx._api.postings[1].account, null);
});

test("Transaction.applyEdit('amount') throws for invalid (NaN) new amount", () => {
  const { sandbox } = loadCode();
  const tx = makeTx(sandbox, singleDestApi());
  assert.throws(
    () => tx.applyEdit('amount', 'bad', '84.25', 2),
    /Invalid amount/
  );
});

test("Transaction.applyEdit('amount') no-op when old amount is NaN (blank cell)", () => {
  const { sandbox } = loadCode();
  const tx = makeTx(sandbox, singleDestApi());
  tx.applyEdit('amount', '50', '', 2);
  assert.equal(tx._api.postings.length, 2);
});

// split_off_amount

test("Transaction.applyEdit('split_off_amount') numeric creates split posting", () => {
  const { sandbox } = loadCode();
  const tx = makeTx(sandbox, singleDestApi());
  tx.applyEdit('split_off_amount', '34.25', '', 2);
  assert.equal(tx._api.postings.length, 3);
  assert.equal(tx._api.postings[1].units.amount, '50');
  assert.equal(tx._api.postings[2].units.amount, '34.25');
  assert.equal(tx._api.postings[2].narration, null);
});

test("Transaction.applyEdit('split_off_amount') 0 is a valid split amount", () => {
  const { sandbox } = loadCode();
  const tx = makeTx(sandbox, singleDestApi());
  tx.applyEdit('split_off_amount', 0, '', 2);
  assert.equal(tx._api.postings.length, 3);
  assert.equal(tx._api.postings[1].units.amount, '84.25');
  assert.equal(tx._api.postings[2].units.amount, '0');
});

test("Transaction.applyEdit('split_off_amount') throws when split equals original", () => {
  const { sandbox } = loadCode();
  const tx = makeTx(sandbox, singleDestApi());
  assert.throws(
    () => tx.applyEdit('split_off_amount', '84.25', '', 2),
    /Split amount must differ from the row amount/
  );
});

test("Transaction.applyEdit('split_off_amount') numeric on source-only creates two null-account postings", () => {
  const { sandbox } = loadCode();

  const tx = makeTx(sandbox, {
    name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: '', narration: 'Interest',
    postings: [
      { account: 'accounts/checking', units: { amount: '-1.5', symbol: 'CHF' } },
      { account: null, units: { amount: '1.5', symbol: 'CHF' } },
    ],
  });
  tx.applyEdit('split_off_amount', '0.5', '', 2);
  assert.equal(tx._api.postings.length, 3);
  assert.equal(tx._api.postings[1].account, null);
  assert.equal(tx._api.postings[1].units.amount, '1');
  assert.equal(tx._api.postings[2].account, null);
  assert.equal(tx._api.postings[2].units.amount, '0.5');
  // source posting unchanged
  assert.equal(tx._api.postings[0].units.amount, '-1.5');
});

test("Transaction.applyEdit('split_off_amount') empty instruction is a no-op", () => {
  const { sandbox } = loadCode();
  const tx = makeTx(sandbox, singleDestApi());
  tx.applyEdit('split_off_amount', '', '', 2);
  assert.equal(tx._api.postings.length, 2);
});

test("Transaction.applyEdit('split_off_amount') x on single destination makes source-only", () => {
  const { sandbox } = loadCode();
  const tx = makeTx(sandbox, singleDestApi());
  tx.applyEdit('split_off_amount', 'x', '', 2);
  assert.equal(tx._api.postings.length, 1);
});

test("Transaction.applyEdit('split_off_amount') x on lower of two rows merges into upper", () => {
  const { sandbox } = loadCode();
  const tx = makeTx(sandbox, splitApi(), { start: 2, count: 2 });
  tx.applyEdit('split_off_amount', 'x', '', 3);
  assert.equal(tx._api.postings.length, 2);
  assert.equal(tx._api.postings[1].account, 'accounts/food');
  assert.equal(parseFloat(tx._api.postings[1].units.amount), 84.25);
});

test("Transaction.applyEdit('split_off_amount') x on upper of two rows merges into lower", () => {
  const { sandbox } = loadCode();
  const tx = makeTx(sandbox, splitApi(), { start: 2, count: 2 });
  tx.applyEdit('split_off_amount', 'x', '', 2);
  assert.equal(tx._api.postings.length, 2);
  assert.equal(tx._api.postings[1].account, 'accounts/household');
  assert.equal(parseFloat(tx._api.postings[1].units.amount), 84.25);
});

test("Transaction.applyEdit('split_off_amount') x reduces to 1 and resets surviving posting narration to null", () => {
  const { sandbox } = loadCode();
  const api = splitApi();
  api.postings[2].narration = 'Household goods';
  const tx = makeTx(sandbox, api, { start: 2, count: 2 });
  tx.applyEdit('split_off_amount', 'x', '', 3);
  assert.equal(tx._api.postings.length, 2);
  assert.equal(tx._api.postings[1].narration, null);
});

test("Transaction.applyEdit('split_off_amount') - is treated as delete like x", () => {
  const { sandbox } = loadCode();
  const tx = makeTx(sandbox, splitApi(), { start: 2, count: 2 });
  tx.applyEdit('split_off_amount', '-', '', 3);
  assert.equal(tx._api.postings.length, 2);
});

test("Transaction.applyEdit('split_off_amount') x promotes surviving posting narration to txn when reducing to single row", () => {
  const { sandbox } = loadCode();
  const api = splitApi();
  api.narration = null;
  api.postings[1].narration = 'Coffee';
  api.postings[2].narration = 'Household goods';
  const tx = makeTx(sandbox, api, { start: 2, count: 2 });
  tx.applyEdit('split_off_amount', 'x', '', 3);
  assert.equal(tx._api.postings.length, 2);
  assert.equal(tx._api.narration, 'Coffee', 'surviving posting narration promoted to txn narration');
  assert.equal(tx._api.postings[1].narration, null, 'surviving posting narration cleared after promotion');
});

test("Transaction.applyEdit('split_off_amount') x keeps txn narration when surviving posting has null narration", () => {
  const { sandbox } = loadCode();
  const api = splitApi();
  api.postings[2].narration = 'Household goods';
  const tx = makeTx(sandbox, api, { start: 2, count: 2 });
  tx.applyEdit('split_off_amount', 'x', '', 3);
  assert.equal(tx._api.postings.length, 2);
  assert.equal(tx._api.narration, 'Groceries', 'txn narration unchanged');
  assert.equal(tx._api.postings[1].narration, null, 'surviving posting narration stays null');
});

// cost/price guard

function costPriceApi() {
  return {
    name: 'transactions/txn_buy',
    transaction_date: '2026-03-01',
    payee: 'IBKR',
    narration: 'VTI purchase',
    postings: [
      {
        account: 'accounts/checking', units: { amount: '-1000', symbol: 'CHF' },
        weight: { amount: '-1000', symbol: 'CHF' }, cost: null, price: null,
      },
      {
        account: 'accounts/food', units: { amount: '5', symbol: 'VTI' },
        weight: { amount: '1000', symbol: 'CHF' }, cost: { amount: '200', symbol: 'CHF' }, price: null,
      },
    ],
  };
}

test("Transaction.applyEdit('destination_account_name') throws for cost/price transaction", () => {
  const { sandbox } = loadCode();
  const tx = makeTx(sandbox, costPriceApi());
  assert.throws(
    () => tx.applyEdit('destination_account_name', '[X] Food', '', 2),
    /Use the sidebar to edit this transaction/
  );
});

test("Transaction.applyEdit('amount') throws for cost/price transaction", () => {
  const { sandbox } = loadCode();
  const tx = makeTx(sandbox, costPriceApi());
  assert.throws(
    () => tx.applyEdit('amount', '900', '1000', 2),
    /Use the sidebar to edit this transaction/
  );
});

test("Transaction.applyEdit('split_off_amount') throws for cost/price transaction", () => {
  const { sandbox } = loadCode();
  const tx = makeTx(sandbox, costPriceApi());
  assert.throws(
    () => tx.applyEdit('split_off_amount', '500', '', 2),
    /Use the sidebar to edit this transaction/
  );
});

test("Transaction.applyEdit('payee') does not throw for cost/price transaction", () => {
  const { sandbox } = loadCode();
  const tx = makeTx(sandbox, costPriceApi());
  assert.doesNotThrow(() => tx.applyEdit('payee', 'New Payee', '', 2));
  assert.equal(tx._api.payee, 'New Payee');
});

test("Transaction.applyEdit('narration') does not throw for cost/price transaction", () => {
  const { sandbox } = loadCode();
  const tx = makeTx(sandbox, costPriceApi());
  assert.doesNotThrow(() => tx.applyEdit('narration', 'Updated', '', 2));
  assert.equal(tx._api.narration, 'Updated');
});

// --- handleEntitySheetEdit_ ---

function makeHandleEditSandbox(toasts) {
  const { sandbox } = loadCode({
    SpreadsheetApp: {
      getActiveSpreadsheet() {
        return { toast(msg, title, sec) { toasts.push({ msg, title, sec }); }, getSpreadsheetTimeZone() { return 'UTC'; } };
      },
    },
  });
  const Transaction = getTransaction(sandbox);
  const fakeEntity = new Transaction(singleDestApi(), {
    accountResourceToDisplayName: {},
    accountDisplayNameToResource: {},
  });
  fakeEntity._span = { start: 2, count: 1 };
  sandbox.findEntityRowsFromAnchor_ = function() { return fakeEntity; };
  sandbox.refreshDoctorIssueSheets_ = function() {};
  return { sandbox, fakeEntity };
}

function makeEditEvent(sandbox, sheet, row, header, value, oldValue) {
  const col = sandbox.getSheetConfigByName_('Transactions').headers.indexOf(header) + 1;
  return {
    range: {
      getSheet() { return sheet; },
      getRow() { return row; },
      getColumn() { return col; },
      getValue() { return value; },
    },
    value: value,
    oldValue: oldValue,
  };
}

test('handleEntitySheetEdit_ calls applyEdit, shows saving toast, and saves entity', () => {
  const toasts = [];
  const { sandbox, fakeEntity } = makeHandleEditSandbox(toasts);
  const savedEntities = [];
  fakeEntity.save = function() { savedEntities.push(this); return this._span; };
  const rowStore = new Map([[2, { resource_name: 'transactions/txn_1' }]]);
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, []);

  sandbox.handleEntitySheetEdit_(makeEditEvent(sandbox, fakeSheet, 2, 'payee', 'Coop', 'Migros'));

  assert.equal(fakeEntity._api.payee, 'Coop');
  assert.equal(savedEntities.length, 1);
  assert.ok(toasts.some(t => /Saving/i.test(t.msg)));
  assert.ok(toasts.some(t => /saved/.test(t.msg)));
});

test('handleEntitySheetEdit_ restores old cell value and toasts on applyEdit validation error', () => {
  const toasts = [];
  const { sandbox, fakeEntity } = makeHandleEditSandbox(toasts);
  fakeEntity.save = function() { throw new Error('should not be called'); };
  const rowStore = new Map([[2, { resource_name: 'transactions/txn_1', amount: 99 }]]);
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, []);

  const col = sandbox.getSheetConfigByName_('Transactions').headers.indexOf('amount') + 1;
  sandbox.handleEntitySheetEdit_({
    range: {
      getSheet() { return fakeSheet; },
      getRow() { return 2; },
      getColumn() { return col; },
      getValue() { return 'notanumber'; },
    },
    value: 'notanumber',
    oldValue: 84.25,
  });

  assert.equal(rowStore.get(2).amount, 84.25);
  assert.ok(toasts.some(t => /Invalid amount/.test(t.msg)));
});

test('handleEntitySheetEdit_ ignores edits on non-entity sheets', () => {
  const { sandbox } = loadCode();
  sandbox.handleEntitySheetEdit_({
    range: {
      getSheet() { return { getName() { return 'Issues'; } }; },
      getRow() { return 2; },
      getColumn() { return 1; },
    },
    value: 'x',
  });
});

test('handleEntitySheetEdit_ ignores edits on header row', () => {
  const { sandbox } = loadCode();
  const called = [];
  sandbox.findEntityRowsFromAnchor_ = function() { called.push(1); };
  const rowStore = new Map();
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, []);
  sandbox.handleEntitySheetEdit_({
    range: {
      getSheet() { return fakeSheet; },
      getRow() { return 1; },
      getColumn() { return 1; },
    },
    value: 'x',
  });
  assert.equal(called.length, 0);
});

test('handleEntitySheetEdit_ ignores non-editable headers', () => {
  const { sandbox } = loadCode();
  const called = [];
  sandbox.findEntityRowsFromAnchor_ = function() { called.push(1); };
  const rowStore = new Map([[2, { resource_name: 'transactions/txn_1' }]]);
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, []);
  sandbox.handleEntitySheetEdit_(makeEditEvent(sandbox, fakeSheet, 2, 'transaction_date', '2026-04-19', ''));
  assert.equal(called.length, 0);
});

test('handleEntitySheetEdit_ toasts save failure without rethrowing', () => {
  const toasts = [];
  const { sandbox, fakeEntity } = makeHandleEditSandbox(toasts);
  fakeEntity.save = function() { throw new Error('API error'); };
  const rowStore = new Map([[2, { resource_name: 'transactions/txn_1' }]]);
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, []);

  sandbox.handleEntitySheetEdit_(makeEditEvent(sandbox, fakeSheet, 2, 'payee', 'Coop', 'Migros'));

  assert.ok(toasts.some(t => /API error/.test(t.msg)));
  assert.ok(!toasts.some(t => /saved/.test(t.msg)));
});

test('handleEntitySheetEdit_ sets posting narration for first row of split transaction narration edit', () => {
  const toasts = [];
  const { sandbox } = loadCode({
    SpreadsheetApp: {
      getActiveSpreadsheet() {
        return { toast(msg, title, sec) { toasts.push({ msg, title, sec }); }, getSpreadsheetTimeZone() { return 'UTC'; } };
      },
    },
  });

  const rowStore = new Map([
    [2, {
      resource_name: 'transactions/txn_1',
      transaction_date: '2026-04-19',
      payee: 'Migros',
      narration: 'Coffee time',
      narration_source: 'txn',
      source_account_name: '[A] Checking',
      destination_account_name: '[X] Food',
      amount: 50,
      split_off_amount: '',
      symbol: 'CHF',
      status: '', last_error: '', issues: '', edit: '',
    }],
    [3, {
      resource_name: 'transactions/txn_1',
      transaction_date: '2026-04-19',
      payee: 'Migros',
      narration: 'Groceries',
      narration_source: 'txn',
      source_account_name: '[A] Checking',
      destination_account_name: '[X] Coffee',
      amount: 34.25,
      split_off_amount: '',
      symbol: 'CHF',
      status: '', last_error: '', issues: '', edit: '',
    }],
  ]);

  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, []);
  sandbox.loadAccountOptions_ = function() {
    return [
      { resource_name: 'accounts/checking', display_name: '[A] Checking' },
      { resource_name: 'accounts/food', display_name: '[X] Food' },
      { resource_name: 'accounts/coffee', display_name: '[X] Coffee' },
    ];
  };
  sandbox.refreshDoctorIssueSheets_ = function() {};
  sandbox.applyAccountValidationToSpan_ = function() {};
  let patchPayload = null;
  sandbox.apiFetchJson_ = function(method, path, payload) {
    if (method === 'patch') {
      patchPayload = payload;
      const posted = payload.transaction;
      return {
        name: 'transactions/txn_1',
        transaction_date: posted.transaction_date,
        payee: posted.payee,
        narration: posted.narration || null,
        postings: posted.postings,
      };
    }
    return {};
  };

  sandbox.handleEntitySheetEdit_(makeEditEvent(sandbox, fakeSheet, 2, 'narration', 'Coffee time', 'Groceries'));

  assert.ok(!toasts.some(t => /error/i.test(t.msg)), 'no error toast: ' + JSON.stringify(toasts));
  assert.ok(patchPayload, 'expected a PATCH call');
  assert.equal(patchPayload.transaction.narration, 'Groceries', 'txn narration must remain Groceries in PATCH');
  assert.equal(patchPayload.transaction.postings[1].narration, 'Coffee time', 'food posting must carry narration Coffee time');
  assert.equal(patchPayload.transaction.postings[2].narration, null, 'coffee posting must keep narration null');
  assert.equal(rowStore.get(2).narration_source, 'post', 'row 2 should be narration_source=post');
  assert.equal(rowStore.get(2).narration, 'Coffee time');
  assert.equal(rowStore.get(3).narration_source, 'txn', 'row 3 should keep narration_source=txn');
  assert.equal(rowStore.get(3).narration, 'Groceries');
});

test('handleEntitySheetEdit_ sets posting narration for split row narration edit', () => {
  const toasts = [];
  const { sandbox } = loadCode({
    SpreadsheetApp: {
      getActiveSpreadsheet() {
        return { toast(msg, title, sec) { toasts.push({ msg, title, sec }); }, getSpreadsheetTimeZone() { return 'UTC'; } };
      },
    },
  });

  const rowStore = new Map([
    [2, {
      resource_name: 'transactions/txn_1',
      transaction_date: '2026-04-19',
      payee: 'Migros',
      narration: 'Groceries',
      narration_source: 'txn',
      source_account_name: '[A] Checking',
      destination_account_name: '[X] Food',
      amount: 50,
      split_off_amount: '',
      symbol: 'CHF',
      status: '', last_error: '', issues: '', edit: '',
    }],
    [3, {
      resource_name: 'transactions/txn_1',
      transaction_date: '2026-04-19',
      payee: 'Migros',
      narration: 'Coffee time',
      narration_source: 'txn',
      source_account_name: '[A] Checking',
      destination_account_name: '[X] Coffee',
      amount: 34.25,
      split_off_amount: '',
      symbol: 'CHF',
      status: '', last_error: '', issues: '', edit: '',
    }],
  ]);

  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, []);
  sandbox.getOrCreateSheet_ = function() { return fakeSheet; };
  sandbox.loadAccountOptions_ = function() {
    return [
      { resource_name: 'accounts/checking', display_name: '[A] Checking' },
      { resource_name: 'accounts/food', display_name: '[X] Food' },
      { resource_name: 'accounts/coffee', display_name: '[X] Coffee' },
    ];
  };
  sandbox.refreshDoctorIssueSheets_ = function() {};
  sandbox.applyAccountValidationToSpan_ = function() {};
  sandbox.apiFetchJson_ = function(method) {
    if (method === 'patch') {
      return {
        name: 'transactions/txn_1',
        transaction_date: '2026-04-19',
        payee: 'Migros',
        narration: 'Groceries',
        postings: [
          { account: 'accounts/checking', units: { amount: '-84.25', symbol: 'CHF' } },
          { account: 'accounts/food', units: { amount: '50', symbol: 'CHF' }, narration: null },
          { account: 'accounts/coffee', units: { amount: '34.25', symbol: 'CHF' }, narration: 'Coffee time' },
        ],
      };
    }
    return {};
  };

  sandbox.handleEntitySheetEdit_(makeEditEvent(sandbox, fakeSheet, 3, 'narration', 'Coffee time', 'Groceries'));

  assert.ok(!toasts.some(t => /error/i.test(t.msg)), 'no error toast: ' + JSON.stringify(toasts));
  assert.equal(rowStore.get(3).narration_source, 'post', 'row 3 should be narration_source=post');
  assert.equal(rowStore.get(3).narration, 'Coffee time');
  assert.equal(rowStore.get(2).narration_source, 'txn', 'row 2 should keep narration_source=txn');
  assert.equal(rowStore.get(2).narration, 'Groceries');
});
