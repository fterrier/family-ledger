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

test('classifyTransactionGroups_ single posting: negative picked as source by rule 4', () => {
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

test('classifyTransactionGroups_ keeps a zero-weight posting as an ordinary destination', () => {
  const { sandbox } = loadCode();

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
  assert.deepEqual(JSON.parse(JSON.stringify(groups[0].destinationIndexes)), [1, 2]);
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
  assert.equal(rows[0].amount, '5000');
  assert.equal(rows[0].symbol, 'CHF');
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
  assert.equal(rows[0].amount, '1000');
  assert.equal(rows[0].symbol, 'CHF');
  assert.equal(rows[0].has_cost_price, true);
});

test('flattenTransactionForSheet_ renders a blank-destination placeholder for a weight-symbol group with no destination', () => {
  // A near-zero (within-tolerance) residual left in its own symbol, with nothing else
  // sharing that symbol, is a real reachable shape — the server doesn't add a filler
  // for a residual within tolerance. Rather than crash rendering the whole sheet (which
  // would abort a sync over one such transaction), show it as a blank-destination row.
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
  const usdRow = rows.find(function(r) { return r.symbol === 'USD'; });
  assert.equal(usdRow.source_account_name, '[A] Bank USD');
  assert.equal(usdRow.destination_account_name, '');
  assert.equal(usdRow.amount, '');
});

test('flattenTransactionForSheet_ falls back to units when weight field absent (backward compat)', () => {
  const { sandbox } = loadCode();

  const rows = sandbox.flattenTransactionForSheet_(sampleTransaction(), {
    'accounts/source': '[A] Bank',
    'accounts/food': '[X] Food',
  });

  assert.equal(rows[0].amount, '84.25');
  assert.equal(rows[0].symbol, 'CHF');
});

test('flattenTransactionForSheet_ hasCostPrice false when no posting has cost or price', () => {
  const { sandbox } = loadCode();

  const rows = sandbox.flattenTransactionForSheet_(sampleTransaction(), {
    'accounts/source': '[A] Bank',
    'accounts/food': '[X] Food',
  });

  assert.equal(rows[0].has_cost_price, false);
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

  // The source's own amount is never computed client-side — its units are
  // omitted entirely so the server interpolates them (see ADR 0006).
  assert.deepEqual(JSON.parse(JSON.stringify(payload)), {
    transaction_date: '2026-04-19',
    payee: 'Migros',
    narration: 'Groceries split',
    postings: [
      { account: 'accounts/source' },
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
  assert.equal('units' in payload.postings[0], false);
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
  assert.equal('units' in payload.postings[0], false);
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
      { account: 'accounts/bank' },
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
    { account: 'accounts/checking' },
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
  assert.equal('units' in payload.postings[0], false);
  assert.equal(payload.postings[1].account, 'accounts/food');
  assert.equal(payload.postings[2].account, 'accounts/household');
});

test('Transaction.fromRows() a lone blank-destination row builds source (no units) plus an unassigned posting', () => {
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

  assert.equal(payload.postings.length, 2);
  assert.equal(payload.postings[0].account, 'accounts/checking');
  assert.equal('units' in payload.postings[0], false);
  assert.equal(payload.postings[1].account, null);
  assert.equal(payload.postings[1].units.amount, '1.5');
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
  assert.equal('units' in tx._api.postings[0], false);
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
  assert.equal('units' in tx._api.postings[0], false);
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

test('Transaction.save() sends every posting including null-account ones, unfiltered', () => {
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

  assert.equal(apiCalls.length, 1);
  const sentPostings = apiCalls[0].payload.transaction.postings;
  assert.equal(sentPostings.length, 3, 'no client-side filtering — the server accepts null accounts directly');
  assert.equal(tx._api.postings.length, 3);
  assert.equal(committed.length, 1, '_commitToSheet_ called after API');
});

test('Transaction.save() with a mix of null and non-null destinations sends all of them', () => {
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

  assert.equal(apiCalls.length, 1);
  const sentPostings = apiCalls[0].payload.transaction.postings;
  assert.equal(sentPostings.length, 3);
  assert.equal(sentPostings[1].account, 'accounts/food');
  assert.equal(sentPostings[2].account, null);
  assert.equal(tx._api.postings.length, 3);
  assert.equal(committed.length, 1, '_commitToSheet_ called after API');
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

test('Transaction.setFields() simple mode with a destination builds 2 full postings, source negated as a plain string', () => {
  const { Transaction } = loadT_();
  const entity = Transaction.fromApi_({
    name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: '', narration: '', postings: [],
  }, ACCOUNT_LOOKUP);

  entity.setFields({
    source_account: 'accounts/checking', destination_account: 'accounts/food', amount: '12.5', symbol: 'CHF',
  });

  assert.deepEqual(JSON.parse(JSON.stringify(entity._api.postings)), [
    { account: 'accounts/checking', units: { amount: '-12.5', symbol: 'CHF' } },
    { account: 'accounts/food', units: { amount: '12.5', symbol: 'CHF' } },
  ]);
});

test('Transaction.setFields() simple mode with no destination still builds 2 full postings: source + an unassigned one', () => {
  const { Transaction } = loadT_();
  const entity = Transaction.fromApi_({
    name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: '', narration: '', postings: [],
  }, ACCOUNT_LOOKUP);

  entity.setFields({ source_account: 'accounts/checking', amount: '0.30000000000000004', symbol: 'CHF' });

  assert.deepEqual(JSON.parse(JSON.stringify(entity._api.postings)), [
    { account: 'accounts/checking', units: { amount: '-0.30000000000000004', symbol: 'CHF' } },
    { account: null, units: { amount: '0.30000000000000004', symbol: 'CHF' } },
  ]);
});

test('Transaction.setFields() simple mode un-negates an already-negative amount string, no parseFloat', () => {
  const { Transaction } = loadT_();
  const entity = Transaction.fromApi_({
    name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: '', narration: '', postings: [],
  }, ACCOUNT_LOOKUP);

  entity.setFields({ source_account: 'accounts/checking', destination_account: 'accounts/food', amount: '-5', symbol: 'CHF' });

  assert.equal(entity._api.postings[0].units.amount, '5');
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
  const editable = ['payee', 'narration', 'destination_account_name', 'split_off_amount', 'tags', 'edit'];
  editable.forEach(function(h) {
    assert.equal(Transaction.isEditableHeader(h), true, h + ' should be editable');
  });
});

test('Transaction.isEditableHeader() returns false for readonly and system headers', () => {
  const { Transaction } = loadT_();
  const nonEditable = ['resource_name', 'transaction_date', 'source_account_name', 'symbol', 'narration_source', 'issues', 'amount', 'unknown'];
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
  assert.equal(Transaction.UPDATE_MASK, 'transaction_date,payee,narration,postings,tags');
});

// --- flattenTransactionForSheet_ date round-trip ---

test('flattenTransactionForSheet_ date round-trips back to yyyy-MM-dd for API payload', () => {
  const { sandbox } = loadCode();
  const rows = sandbox.flattenTransactionForSheet_(sampleTransaction(), {
    'accounts/source': '[A] Bank - Checking',
    'accounts/food': '[X] Food',
  });
  // A real Sheets write+read cycle turns the written numeric string back into a genuine
  // number (Sheets parses on write, per the amount column's numberFormat) — simulate
  // that here since this test chains straight into buildTransactionPatchPayload_ with
  // no real sheet in between.
  rows.forEach(function(row) { row.amount = Number(row.amount); });
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
    update_time: 1755000000,
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
    update_time: 1755000000,
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

// split_off_amount — sets _pendingServerOp for a :split/:unsplit call; no client-side arithmetic.

test("Transaction.applyEdit('split_off_amount') numeric sets a pending :split op, verbatim amount, no posting mutation", () => {
  const { sandbox } = loadCode();
  const tx = makeTx(sandbox, singleDestApi());
  tx.applyEdit('split_off_amount', '34.25', '', 2);
  assert.deepEqual(JSON.parse(JSON.stringify(tx._pendingServerOp)), {
    verb: 'split',
    body: { posting_index: 1, split_off_amount: '34.25', update_time: 1755000000 },
  });
  assert.equal(tx._api.postings.length, 2, 'postings are not mutated client-side');
});

test("Transaction.applyEdit('split_off_amount') numeric 0 sends '0' verbatim", () => {
  const { sandbox } = loadCode();
  const tx = makeTx(sandbox, singleDestApi());
  tx.applyEdit('split_off_amount', 0, '', 2);
  assert.equal(tx._pendingServerOp.body.split_off_amount, '0');
});

test("Transaction.applyEdit('split_off_amount') throws for a non-numeric split amount", () => {
  const { sandbox } = loadCode();
  const tx = makeTx(sandbox, singleDestApi());
  assert.throws(
    () => tx.applyEdit('split_off_amount', 'abc', '', 2),
    /Invalid split amount/
  );
});

test("Transaction.applyEdit('split_off_amount') numeric on a split row targets that row's posting_index", () => {
  const { sandbox } = loadCode();
  const tx = makeTx(sandbox, splitApi(), { start: 2, count: 2 });
  tx.applyEdit('split_off_amount', '10', '', 3);
  assert.equal(tx._pendingServerOp.body.posting_index, 2);
});

test("Transaction.applyEdit('split_off_amount') empty instruction is a no-op", () => {
  const { sandbox } = loadCode();
  const tx = makeTx(sandbox, singleDestApi());
  tx.applyEdit('split_off_amount', '', '', 2);
  assert.equal(tx._pendingServerOp, undefined);
  assert.equal(tx._api.postings.length, 2);
});

test("Transaction.applyEdit('split_off_amount') x sets a pending :unsplit op with no second index", () => {
  const { sandbox } = loadCode();
  const tx = makeTx(sandbox, singleDestApi());
  tx.applyEdit('split_off_amount', 'x', '', 2);
  assert.deepEqual(JSON.parse(JSON.stringify(tx._pendingServerOp)), {
    verb: 'unsplit',
    body: { posting_index: 1, update_time: 1755000000 },
  });
  assert.equal(tx._api.postings.length, 2, 'postings are not mutated client-side');
});

test("Transaction.applyEdit('split_off_amount') X (uppercase) is treated the same as x", () => {
  const { sandbox } = loadCode();
  const tx = makeTx(sandbox, singleDestApi());
  tx.applyEdit('split_off_amount', 'X', '', 2);
  assert.equal(tx._pendingServerOp.verb, 'unsplit');
});

test("Transaction.applyEdit('split_off_amount') - is treated as delete like x", () => {
  const { sandbox } = loadCode();
  const tx = makeTx(sandbox, splitApi(), { start: 2, count: 2 });
  tx.applyEdit('split_off_amount', '-', '', 3);
  assert.deepEqual(JSON.parse(JSON.stringify(tx._pendingServerOp)), {
    verb: 'unsplit',
    body: { posting_index: 2, update_time: 1755000000 },
  });
});

// tags

test("Transaction.applyEdit('tags') parses comma-separated tags", () => {
  const { sandbox } = loadCode();
  const tx = makeTx(sandbox, singleDestApi());
  tx.applyEdit('tags', 'salary2024, bonus', '', 2);
  assert.deepEqual(JSON.parse(JSON.stringify(tx._api.tags)), ['salary2024', 'bonus']);
});

test("Transaction.applyEdit('tags') clears tags on empty string", () => {
  const { sandbox } = loadCode();
  const tx = makeTx(sandbox, singleDestApi());
  tx.applyEdit('tags', '', '', 2);
  assert.deepEqual(JSON.parse(JSON.stringify(tx._api.tags)), []);
});

test('Transaction.fromRows() reads tags from sheet rows so non-tags edits preserve them', () => {
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
    tags: 'salary2024, bonus',
    __rowNumber: 2,
  }];

  const tx = Transaction.fromRows(rows, ACCOUNT_LOOKUP, { start: 2, count: 1 });
  assert.deepEqual(JSON.parse(JSON.stringify(tx._api.tags)), ['salary2024', 'bonus']);
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
    /please use the sidebar/
  );
});

test("Transaction.applyEdit('split_off_amount') throws for cost/price transaction", () => {
  const { sandbox } = loadCode();
  const tx = makeTx(sandbox, costPriceApi());
  assert.throws(
    () => tx.applyEdit('split_off_amount', '500', '', 2),
    /please use the sidebar/
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

// _hasCostPrice — sheet-flagged complex transactions (postings carry no cost/price in sheet path)

function complexSheetRow(overrides) {
  return Object.assign({
    resource_name: 'transactions/txn_buy',
    transaction_date: '2026-03-01',
    payee: 'IBKR',
    narration: 'VTI purchase',
    narration_source: 'txn',
    source_account_name: '[A] Checking',
    destination_account_name: '[X] Food',
    amount: 1000,
    symbol: 'CHF',
    has_cost_price: true,
    __rowNumber: 2,
  }, overrides);
}

test('Transaction.fromRows() sets _hasCostPrice true when hasCostPrice is true in rows', () => {
  const { Transaction } = loadT_();
  const tx = Transaction.fromRows([complexSheetRow()], ACCOUNT_LOOKUP, { start: 2, count: 1 });
  assert.equal(tx._hasCostPrice, true);
});

test('Transaction.fromRows() sets _hasCostPrice false when hasCostPrice is false in rows', () => {
  const { Transaction } = loadT_();
  const row = complexSheetRow({ has_cost_price: false });
  const tx = Transaction.fromRows([row], ACCOUNT_LOOKUP, { start: 2, count: 1 });
  assert.equal(tx._hasCostPrice, false);
});

test("Transaction.applyEdit('payee') on sheet-flagged complex tx sets payee mask and does not throw", () => {
  const { Transaction } = loadT_();
  const tx = Transaction.fromRows([complexSheetRow()], ACCOUNT_LOOKUP, { start: 2, count: 1 });
  assert.doesNotThrow(() => tx.applyEdit('payee', 'New Payee', '', 2));
  assert.equal(tx._api.payee, 'New Payee');
  assert.equal(tx._updateMask, 'payee');
});

test("Transaction.applyEdit('narration') single-row on sheet-flagged complex tx sets narration mask and does not throw", () => {
  const { Transaction } = loadT_();
  const tx = Transaction.fromRows([complexSheetRow()], ACCOUNT_LOOKUP, { start: 2, count: 1 });
  assert.doesNotThrow(() => tx.applyEdit('narration', 'Updated narration', '', 2));
  assert.equal(tx._api.narration, 'Updated narration');
  assert.equal(tx._updateMask, 'narration');
});

test("Transaction.applyEdit('narration') multi-row on sheet-flagged complex tx throws", () => {
  const { Transaction } = loadT_();
  const rows = [
    complexSheetRow({ __rowNumber: 2 }),
    complexSheetRow({ destination_account_name: '[X] Household', amount: 200, __rowNumber: 3 }),
  ];
  const tx = Transaction.fromRows(rows, ACCOUNT_LOOKUP, { start: 2, count: 2 });
  assert.throws(
    () => tx.applyEdit('narration', 'Updated', 'VTI purchase', 2),
    /please use the sidebar/
  );
});

test("Transaction.applyEdit('destination_account_name') on sheet-flagged complex tx throws", () => {
  const { Transaction } = loadT_();
  const tx = Transaction.fromRows([complexSheetRow()], ACCOUNT_LOOKUP, { start: 2, count: 1 });
  assert.throws(
    () => tx.applyEdit('destination_account_name', '[X] Food', '', 2),
    /please use the sidebar/
  );
});

test('Transaction.save() uses payee-only update_mask after payee edit', () => {
  const { sandbox } = loadCode();
  const apiCalls = [];
  sandbox.apiFetchJson_ = function(method, path, payload) {
    apiCalls.push({ method, path, payload });
    const posted = payload.transaction;
    return { name: 'transactions/txn_buy', transaction_date: posted.transaction_date, payee: posted.payee, narration: posted.narration, postings: [] };
  };
  const props = {};
  sandbox.PropertiesService = { getDocumentProperties() { return { getProperty(k) { return props[k] || null; }, setProperty(k, v) { props[k] = v; } }; } };
  const Transaction = getTransaction(sandbox);
  const tx = Transaction.fromRows([complexSheetRow()], ACCOUNT_LOOKUP, { start: 2, count: 1 });
  tx.applyEdit('payee', 'New Payee', 'IBKR', 2);
  tx._commitToSheet_ = function() { return this._span; };

  tx.save({});

  assert.equal(apiCalls.length, 1);
  assert.equal(apiCalls[0].payload.update_mask, 'payee');
});

test('Transaction.save() uses full update_mask for tags inline edit', () => {
  const { sandbox } = loadCode();
  const apiCalls = [];
  sandbox.apiFetchJson_ = function(method, path, payload) {
    apiCalls.push({ method, path, payload });
    const posted = payload.transaction;
    return { name: 'transactions/txn_1', transaction_date: posted.transaction_date, payee: posted.payee, narration: posted.narration, postings: posted.postings || [], tags: posted.tags || [] };
  };
  const props = {};
  sandbox.PropertiesService = { getDocumentProperties() { return { getProperty(k) { return props[k] || null; }, setProperty(k, v) { props[k] = v; } }; } };
  const tx = makeTx(sandbox, singleDestApi());
  tx.applyEdit('tags', 'salary2024', '', 2);
  tx._commitToSheet_ = function() { return this._span; };

  tx.save({});

  assert.equal(apiCalls.length, 1);
  assert.equal(apiCalls[0].payload.update_mask, 'tags');
  assert.deepEqual(JSON.parse(JSON.stringify(apiCalls[0].payload.transaction.tags)), ['salary2024']);
});

test('Transaction.save() uses postings update_mask (no tags) for destination_account edit', () => {
  const { sandbox } = loadCode();
  const apiCalls = [];
  sandbox.apiFetchJson_ = function(method, path, payload) {
    apiCalls.push({ method, path, payload });
    const posted = payload.transaction;
    return { name: 'transactions/txn_1', transaction_date: posted.transaction_date, payee: posted.payee, narration: posted.narration, postings: posted.postings || [] };
  };
  const props = {};
  sandbox.PropertiesService = { getDocumentProperties() { return { getProperty(k) { return props[k] || null; }, setProperty(k, v) { props[k] = v; } }; } };
  const tx = makeTx(sandbox, singleDestApi());
  tx.applyEdit('destination_account_name', '[X] Household', '[X] Food', 2);
  tx._commitToSheet_ = function() { return this._span; };

  tx.save({});

  assert.equal(apiCalls.length, 1);
  assert.equal(apiCalls[0].payload.update_mask, 'postings');
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
  const rowStore = new Map([[2, { resource_name: 'transactions/txn_1', split_off_amount: 'notanumber' }]]);
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, []);

  sandbox.handleEntitySheetEdit_(makeEditEvent(sandbox, fakeSheet, 2, 'split_off_amount', 'notanumber', ''));

  assert.equal(rowStore.get(2).split_off_amount, '');
  assert.ok(toasts.some(t => /Invalid split amount/.test(t.msg)));
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
      issues: '', edit: '',
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
      issues: '', edit: '',
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
        // The real server interpolates the source posting's units from the
        // (unchanged) destination amounts — 50 + 34.25. Spelled out here since
        // the mock doesn't run that computation itself.
        postings: [
          { account: 'accounts/checking', units: { amount: '-84.25', symbol: 'CHF' } },
          posted.postings[1],
          posted.postings[2],
        ],
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

test('handleEntitySheetEdit_ saves a tags edit and writes it back to the sheet', () => {
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
      amount: 84.25,
      split_off_amount: '',
      symbol: 'CHF',
      tags: '',
      issues: '', edit: '',
    }],
  ]);

  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, []);
  sandbox.loadAccountOptions_ = function() {
    return [
      { resource_name: 'accounts/checking', display_name: '[A] Checking' },
      { resource_name: 'accounts/food', display_name: '[X] Food' },
    ];
  };
  sandbox.refreshDoctorIssueSheets_ = function() {};
  sandbox.applyAccountValidationToSpan_ = function() {};
  let patchPayload = null;
  sandbox.apiFetchJson_ = function(method, path, payload) {
    if (method === 'patch') {
      patchPayload = payload;
      const posted = payload.transaction;
      // Real server response: update_mask is 'tags', so postings aren't
      // touched — this reflects a DB reload with the original (unchanged,
      // fully-specified) postings, not an echo of the client's request
      // (which omits the source posting's units — see
      // buildTransactionPatchPayload_'s comment on that).
      return {
        name: 'transactions/txn_1',
        transaction_date: posted.transaction_date,
        payee: posted.payee,
        narration: posted.narration || null,
        postings: [
          { account: 'accounts/checking', units: { amount: '-84.25', symbol: 'CHF' } },
          { account: 'accounts/food', units: { amount: '84.25', symbol: 'CHF' }, narration: null },
        ],
        tags: posted.tags || [],
      };
    }
    return {};
  };

  sandbox.handleEntitySheetEdit_(makeEditEvent(sandbox, fakeSheet, 2, 'tags', 'vacation, 2026', ''));

  assert.ok(!toasts.some(t => /error/i.test(t.msg)), 'no error toast: ' + JSON.stringify(toasts));
  assert.ok(patchPayload, 'expected a PATCH call');
  assert.equal(patchPayload.update_mask, 'tags');
  assert.deepEqual(JSON.parse(JSON.stringify(patchPayload.transaction.tags)), ['vacation', '2026']);
  assert.equal(rowStore.get(2).tags, 'vacation, 2026');
});

test('handleEntitySheetEdit_ editing payee on one row of a split transaction does not throw', () => {
  // GAS already writes the new value into the edited cell before onEdit fires — row 2
  // (the anchor) shows the NEW payee "Coop", but row 3 hasn't been touched and still
  // shows the OLD payee "Migros". Without an override, reconstruction sees two
  // different payee values across the group and throws "Inconsistent payee...".
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
      payee: 'Coop',
      narration: 'Groceries',
      narration_source: 'txn',
      source_account_name: '[A] Checking',
      destination_account_name: '[X] Food',
      amount: 50,
      split_off_amount: '',
      symbol: 'CHF',
      issues: '', edit: '',
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
      issues: '', edit: '',
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
        postings: [
          { account: 'accounts/checking', units: { amount: '-84.25', symbol: 'CHF' } },
          posted.postings[1],
          posted.postings[2],
        ],
      };
    }
    return {};
  };

  sandbox.handleEntitySheetEdit_(makeEditEvent(sandbox, fakeSheet, 2, 'payee', 'Coop', 'Migros'));

  assert.ok(!toasts.some(t => /inconsistent/i.test(t.msg)), 'no inconsistent-payee toast: ' + JSON.stringify(toasts));
  assert.ok(patchPayload, 'expected a PATCH call');
  assert.equal(patchPayload.transaction.payee, 'Coop');
  assert.equal(rowStore.get(2).payee, 'Coop');
  assert.equal(rowStore.get(3).payee, 'Coop');
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
      issues: '', edit: '',
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
      issues: '', edit: '',
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
