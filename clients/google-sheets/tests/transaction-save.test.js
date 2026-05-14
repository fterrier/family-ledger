const test = require('node:test');
const assert = require('node:assert/strict');

const { loadCode, sampleTransaction, makeRowStoreSheet_ } = require('./_harness');

test('save generation helpers ignore stale responses', () => {
  const { sandbox, documentProperties } = loadCode();

  const first = sandbox.beginSaveGeneration_('transactions/txn_1');
  const second = sandbox.beginSaveGeneration_('transactions/txn_1');

  assert.equal(first, '1');
  assert.equal(second, '2');
  assert.equal(documentProperties.get('family_ledger_save_generation:transactions/txn_1'), '2');
  assert.equal(sandbox.isCurrentSaveGeneration_('transactions/txn_1', '1'), false);
  assert.equal(sandbox.isCurrentSaveGeneration_('transactions/txn_1', '2'), true);
});

test('saveTransactionByName_ keeps doctor issues and records transient PATCH errors separately', () => {
  const operations = [];
  const rowStore = new Map([
    [2, {
      resource_name: 'transactions/txn_1',
      transaction_date: '2026-04-19',
      payee: 'Migros',
      narration: 'Groceries',
      source_account_name: 'Assets:Bank:Checking',
      destination_account_name: 'Expenses:Food',
      amount: 84.25,
      split_off_amount: '',
      symbol: 'CHF',
      status: 'dirty',
      issues: 'transaction_unbalanced (CHF, residual -4.25, tolerance 0.005)',
      last_error: '',
    }],
  ]);
  const { sandbox } = loadCode();
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, operations);

  sandbox.buildTransactionPatchPayloadFromGroup_ = function() {
    return { transaction_date: '2026-04-19', postings: [] };
  };
  sandbox.apiFetchJson_ = function(method) {
    if (method === 'patch') {
      throw new Error('transaction_unbalanced: Transaction is not balanced within tolerance.');
    }
    return {};
  };

  const row2 = { ...rowStore.get(2), __rowNumber: 2 };
  const preloadedAccounts = { nameMap: {}, displayLookup: {} };
  sandbox.saveTransactionByName_(fakeSheet, { rowNumbers: [2], transactionName: 'transactions/txn_1', rows: [row2] }, {}, preloadedAccounts);

  assert.equal(rowStore.get(2).issues, 'transaction_unbalanced (CHF, residual -4.25, tolerance 0.005)');
  assert.equal(rowStore.get(2).last_error, 'transaction_unbalanced: Transaction is not balanced within tolerance.');
  assert.equal(rowStore.get(2).status, 'error');
});

test('saveTransactionByName_ keeps saved state when doctor refresh fails after successful patch', () => {
  const operations = [];
  const toasts = [];
  const rowStore = new Map([
    [2, {
      resource_name: 'transactions/txn_1',
      transaction_date: '2026-04-19',
      payee: 'Migros',
      narration: 'Groceries',
      source_account_name: 'Assets:Bank:Checking',
      destination_account_name: 'Expenses:Food',
      amount: 84.25,
      split_off_amount: '',
      symbol: 'CHF',
      status: 'dirty',
      issues: '',
      last_error: '',
    }],
  ]);
  const { sandbox } = loadCode({
    SpreadsheetApp: {
      getActiveSpreadsheet() {
        return {
          toast(message, title, seconds) { toasts.push({ message, title, seconds }); },
        };
      },
    },
  });
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, operations);

  sandbox.buildTransactionPatchPayloadFromGroup_ = function() {
    return { transaction_date: '2026-04-19', postings: [] };
  };
  sandbox.apiFetchJson_ = function(method) {
    if (method === 'patch') {
      return sampleTransaction();
    }
    throw new Error('unexpected api call');
  };
  sandbox.refreshDoctorIssueSheets_ = function() {
    throw new Error('doctor temporarily unavailable');
  };

  const row2 = { ...rowStore.get(2), __rowNumber: 2 };
  const preloadedAccounts = {
    nameMap: { 'Assets:Bank:Checking': 'accounts/source', 'Expenses:Food': 'accounts/food' },
    displayLookup: { 'accounts/source': 'Assets:Bank:Checking', 'accounts/food': 'Expenses:Food' },
    validationRule: null,
  };
  sandbox.saveTransactionByName_(fakeSheet, { rowNumbers: [2], transactionName: 'transactions/txn_1', rows: [row2] }, {}, preloadedAccounts);

  assert.equal(rowStore.get(2).status, 'saved');
  assert.equal(rowStore.get(2).last_error, '');
  assert.equal(toasts.length, 1);
  assert.match(toasts[0].message, /Saved changes, but failed to refresh ledger doctor issues/);
});

test('saveTransactionByName_ passes the preloaded account display lookup to the doctor', () => {
  const operations = [];
  const rowStore = new Map([
    [2, {
      resource_name: 'transactions/txn_1',
      transaction_date: '2026-04-19',
      payee: 'Migros',
      narration: 'Groceries',
      source_account_name: '[+] Checking',
      destination_account_name: '[E] Food',
      amount: 84.25,
      split_off_amount: '',
      symbol: 'CHF',
      status: 'dirty',
      issues: '',
      last_error: '',
    }],
  ]);
  const { sandbox } = loadCode({
    SpreadsheetApp: {
      getActiveSpreadsheet() {
        return { toast() {} };
      },
    },
  });
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, operations);

  sandbox.buildTransactionPatchPayloadFromGroup_ = function() {
    return { transaction_date: '2026-04-19', postings: [] };
  };
  sandbox.apiFetchJson_ = function(method) {
    if (method === 'patch') return sampleTransaction();
    throw new Error('unexpected api call');
  };

  let capturedLookup;
  sandbox.refreshDoctorIssueSheets_ = function(accountLookup) {
    capturedLookup = accountLookup;
  };

  const row2 = { ...rowStore.get(2), __rowNumber: 2 };
  const displayLookup = { 'accounts/source': '[+] Checking', 'accounts/food': '[E] Food' };
  const preloadedAccounts = { nameMap: {}, displayLookup: displayLookup };
  sandbox.saveTransactionByName_(fakeSheet, { rowNumbers: [2], transactionName: 'transactions/txn_1', rows: [row2] }, {}, preloadedAccounts);

  assert.deepEqual(capturedLookup, displayLookup);
});
