const test = require('node:test');
const assert = require('node:assert/strict');

const { loadCode, makeRowStoreSheet_ } = require('./_harness');

function makeTwoPostingTransaction(overrides) {
  return Object.assign({
    name: 'transactions/txn_1',
    transaction_date: '2026-04-19',
    payee: 'Migros',
    narration: 'Groceries',
    postings: [
      { account: 'accounts/cash', units: { amount: '-84.25', symbol: 'CHF' } },
      { account: 'accounts/food', units: { amount: '84.25', symbol: 'CHF' } },
    ],
  }, overrides);
}

test('getEditTransactionData extracts source, dest, amount, symbol for 2-posting transaction', () => {
  const { sandbox } = loadCode();
  sandbox.apiFetchJson_ = function(_method, _path) {
    return makeTwoPostingTransaction();
  };
  sandbox.listAccountOptions_ = function() { return []; };
  sandbox.listCommodityOptions_ = function() { return []; };

  const data = sandbox.getEditTransactionData('transactions/txn_1');

  assert.equal(data.postingCount, 2);
  assert.equal(data.sourceAccount, 'accounts/cash');
  assert.equal(data.destinationAccount, 'accounts/food');
  assert.equal(data.amount, 84.25);
  assert.equal(data.symbol, 'CHF');
  assert.equal(data.transaction.payee, 'Migros');
});

test('getEditTransactionData returns only postingCount for 3+ posting transaction', () => {
  const { sandbox } = loadCode();
  sandbox.apiFetchJson_ = function() {
    return {
      name: 'transactions/txn_2',
      transaction_date: '2026-04-19',
      payee: 'Split',
      narration: '',
      postings: [
        { account: 'accounts/cash', units: { amount: '-100', symbol: 'CHF' } },
        { account: 'accounts/food', units: { amount: '60', symbol: 'CHF' } },
        { account: 'accounts/coffee', units: { amount: '40', symbol: 'CHF' } },
      ],
    };
  };
  sandbox.listAccountOptions_ = function() { return []; };
  sandbox.listCommodityOptions_ = function() { return []; };

  const data = sandbox.getEditTransactionData('transactions/txn_2');

  assert.equal(data.postingCount, 3);
  assert.equal(data.sourceAccount, undefined);
  assert.equal(data.destinationAccount, undefined);
  assert.equal(data.amount, undefined);
});

test('deleteTransactionFromSidebar calls DELETE and removes rows from sheet', () => {
  const operations = [];
  const rowStore = new Map([
    [2, { resource_name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: 'Migros', narration: '' }],
    [3, { resource_name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: 'Migros', narration: '' }],
    [4, { resource_name: 'transactions/txn_2', transaction_date: '2026-04-20', payee: 'Other', narration: '' }],
  ]);

  const apiCalls = [];
  const { sandbox } = loadCode({
    SpreadsheetApp: { getActiveSpreadsheet() { return { toast() {}, getSheetByName() { return null; } }; } },
  });
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, operations);
  sandbox.apiFetchJson_ = function(method, path) {
    apiCalls.push({ method, path });
    return {};
  };
  sandbox.getOrCreateSheet_ = function() { return fakeSheet; };
  sandbox.refreshDoctorIssueSheets_ = function() {};

  sandbox.deleteTransactionFromSidebar('transactions/txn_1', 2);

  assert.ok(apiCalls.some(c => c.method === 'delete' && c.path === '/transactions/txn_1'), 'expected DELETE call');
  assert.ok(!rowStore.has(3), 'row 3 should be gone after deletion and shift');
  assert.ok(!rowStore.has(4), 'original row 4 should have shifted away');
  assert.equal(rowStore.get(2).resource_name, 'transactions/txn_2', 'txn_2 should shift to row 2');
});

test('saveTransactionFromSidebar sends correct 2-posting PATCH payload', () => {
  const operations = [];
  const rowStore = new Map([
    [2, { resource_name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: 'Old', narration: '', source_account_name: 'Cash', destination_account_name: 'Food', symbol: 'CHF', amount: 84.25, split_off_amount: '', status: '', last_error: '', issues: '', narration_source: 'txn', edit: '' }],
  ]);

  const apiCalls = [];
  const { sandbox } = loadCode({
    SpreadsheetApp: { getActiveSpreadsheet() { return { toast() {}, getSheetByName() { return null; } }; } },
  });
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, operations);
  sandbox.apiFetchJson_ = function(method, path, payload) {
    apiCalls.push({ method, path, payload });
    if (method === 'patch') {
      return makeTwoPostingTransaction({ payee: 'Migros Updated', narration: 'Updated' });
    }
    return {};
  };
  sandbox.getOrCreateSheet_ = function() { return fakeSheet; };
  sandbox.loadAccountDisplayLookup_ = function() {
    return { 'accounts/cash': '[A] Cash', 'accounts/food': '[X] Food' };
  };
  sandbox.refreshDoctorIssueSheets_ = function() {};
  sandbox.applyAccountValidationToRowNumbers_ = function() {};
  sandbox.applyTransactionIssueFormulasToRowNumbers_ = function() {};

  sandbox.submitTransactionFromSidebar('transactions/txn_1', 2, {
    transaction_date: '2026-04-19',
    payee: 'Migros Updated',
    narration: 'Updated',
    postingCount: 2,
    source_account: 'accounts/cash',
    destination_account: 'accounts/food',
    amount: '84.25',
    symbol: 'CHF',
  });

  const patchCall = apiCalls.find(c => c.method === 'patch');
  assert.ok(patchCall, 'expected PATCH call');
  assert.equal(patchCall.path, '/transactions/txn_1');
  assert.equal(patchCall.payload.update_mask, 'transaction_date,payee,narration,postings');
  assert.deepEqual(JSON.parse(JSON.stringify(patchCall.payload.transaction.postings)), [
    { account: 'accounts/cash', units: { amount: '-84.25', symbol: 'CHF' } },
    { account: 'accounts/food', units: { amount: '84.25', symbol: 'CHF' } },
  ]);
});

const RAW_3_POSTINGS = [
  { account: 'accounts/cash', units: { amount: '-100', symbol: 'CHF' } },
  { account: 'accounts/food', units: { amount: '60', symbol: 'CHF' } },
  { account: 'accounts/coffee', units: { amount: '40', symbol: 'CHF' } },
];

test('submitTransactionFromSidebar passes raw postings through for 3+ posting transaction', () => {
  const operations = [];
  const rowStore = new Map([
    [2, { resource_name: 'transactions/txn_2', transaction_date: '2026-04-19', payee: 'Split', narration: '', source_account_name: 'Cash', destination_account_name: 'Food', symbol: 'CHF', amount: 60, split_off_amount: '', status: '', last_error: '', issues: '', narration_source: 'txn', edit: '' }],
    [3, { resource_name: 'transactions/txn_2', transaction_date: '2026-04-19', payee: 'Split', narration: '', source_account_name: 'Cash', destination_account_name: 'Coffee', symbol: 'CHF', amount: 40, split_off_amount: '', status: '', last_error: '', issues: '', narration_source: 'txn', edit: '' }],
  ]);

  const apiCalls = [];
  const { sandbox } = loadCode({
    SpreadsheetApp: { getActiveSpreadsheet() { return { toast() {}, getSheetByName() { return null; } }; } },
  });
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, operations);
  sandbox.apiFetchJson_ = function(method, path, payload) {
    apiCalls.push({ method, path, payload });
    if (method === 'patch') {
      return { name: 'transactions/txn_2', transaction_date: '2026-04-19', payee: 'Updated', narration: 'New narration', postings: RAW_3_POSTINGS };
    }
    return {};
  };
  sandbox.getOrCreateSheet_ = function() { return fakeSheet; };
  sandbox.loadAccountDisplayLookup_ = function() {
    return { 'accounts/cash': '[A] Cash', 'accounts/food': '[X] Food', 'accounts/coffee': '[X] Coffee' };
  };
  sandbox.refreshDoctorIssueSheets_ = function() {};
  sandbox.applyAccountValidationToRowNumbers_ = function() {};
  sandbox.applyTransactionIssueFormulasToRowNumbers_ = function() {};

  sandbox.submitTransactionFromSidebar('transactions/txn_2', 2, {
    transaction_date: '2026-04-19',
    payee: 'Updated',
    narration: 'New narration',
    postingCount: 3,
    rawPostings: RAW_3_POSTINGS,
  });

  const patchCall = apiCalls.find(c => c.method === 'patch');
  assert.ok(patchCall, 'expected PATCH call');
  assert.equal(patchCall.payload.update_mask, 'transaction_date,payee,narration,postings');
  assert.deepEqual(JSON.parse(JSON.stringify(patchCall.payload.transaction.postings)), RAW_3_POSTINGS);
});
