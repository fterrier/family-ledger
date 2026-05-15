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
      source_account_name: '[A] Bank - Checking',
      destination_account_name: '[X] Food',
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
  sandbox.saveTransactionByName_(fakeSheet, { rowNumbers: [2], transactionName: 'transactions/txn_1', rows: [row2] }, {}, []);

  assert.equal(rowStore.get(2).issues, 'transaction_unbalanced (CHF, residual -4.25, tolerance 0.005)');
  assert.equal(rowStore.get(2).last_error, 'transaction_unbalanced: Transaction is not balanced within tolerance.');
  assert.equal(rowStore.get(2).status, 'error');
});

test('saveTransactionByName_ clears status to empty after doctor refresh fails following successful patch', () => {
  const operations = [];
  const toasts = [];
  const rowStore = new Map([
    [2, {
      resource_name: 'transactions/txn_1',
      transaction_date: '2026-04-19',
      payee: 'Migros',
      narration: 'Groceries',
      source_account_name: '[A] Bank - Checking',
      destination_account_name: '[X] Food',
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
  sandbox.applyAccountValidationToRowNumbers_ = function() {};
  sandbox.applyTransactionIssueFormulasToRowNumbers_ = function() {};

  const row2 = { ...rowStore.get(2), __rowNumber: 2 };
  const accountOptions = [
    { resource_name: 'accounts/source', display_name: '[A] Bank - Checking' },
    { resource_name: 'accounts/food', display_name: '[X] Food' },
  ];
  sandbox.saveTransactionByName_(fakeSheet, { rowNumbers: [2], transactionName: 'transactions/txn_1', rows: [row2] }, {}, accountOptions);

  assert.equal(rowStore.get(2).status, '');
  assert.equal(rowStore.get(2).last_error, '');
  // Doctor failure toast + success toast (both fired; doctor failure comes first from saveTransactionToSheet_)
  assert.equal(toasts.length, 2);
  assert.match(toasts[0].message, /Saved changes, but failed to refresh ledger doctor issues/);
  assert.equal(toasts[1].message, 'Transaction saved.');
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
  sandbox.applyAccountValidationToRowNumbers_ = function() {};
  sandbox.applyTransactionIssueFormulasToRowNumbers_ = function() {};

  let capturedLookup;
  sandbox.refreshDoctorIssueSheets_ = function(accountLookup) {
    capturedLookup = accountLookup;
  };

  const row2 = { ...rowStore.get(2), __rowNumber: 2 };
  const accountOptions = [
    { resource_name: 'accounts/source', display_name: '[+] Checking' },
    { resource_name: 'accounts/food', display_name: '[E] Food' },
  ];
  sandbox.saveTransactionByName_(fakeSheet, { rowNumbers: [2], transactionName: 'transactions/txn_1', rows: [row2] }, {}, accountOptions);

  assert.deepEqual(JSON.parse(JSON.stringify(capturedLookup)), { 'accounts/source': '[+] Checking', 'accounts/food': '[E] Food' });
});

// --- saveTransactionToSheet_ ---
// These tests mock flattenTransactionForSheet_ and applyTransactionResponseToSheet_
// to keep focus on the lifecycle behavior (status tracking, error handling, generation).

function makeSaveTransactionSandbox(rowStore, overrides) {
  const { sandbox } = loadCode(overrides);
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, []);
  // Default mocks for the flatten+apply+doctor steps; override per test when testing those paths.
  sandbox.flattenTransactionForSheet_ = function() {
    return [{ transaction_date: '2026-04-19', status: '', last_error: '', split_off_amount: '' }];
  };
  sandbox.applyTransactionResponseToSheet_ = function(sheet, rowNumbers) {
    return rowNumbers || [2];
  };
  sandbox.refreshDoctorIssueSheets_ = function() {};
  return { sandbox, fakeSheet };
}

test('saveTransactionToSheet_ sets saving status before doApiCall, clears to empty after success', () => {
  const rowStore = new Map([[2, { status: 'dirty', last_error: '' }]]);
  const { sandbox, fakeSheet } = makeSaveTransactionSandbox(rowStore);
  const statusDuringApiCall = [];

  sandbox.saveTransactionToSheet_(fakeSheet, [2], null, 'transactions/txn_1', {},
    function() {
      statusDuringApiCall.push(rowStore.get(2).status);
      return { name: 'transactions/txn_1' };
    }
  );

  assert.deepEqual(statusDuringApiCall, ['saving']);
  assert.equal(rowStore.get(2).status, '');
});

test('saveTransactionToSheet_ writes error status and last_error on doApiCall failure', () => {
  const rowStore = new Map([[2, { status: 'dirty', last_error: '' }]]);
  const { sandbox, fakeSheet } = makeSaveTransactionSandbox(rowStore);

  assert.throws(function() {
    sandbox.saveTransactionToSheet_(fakeSheet, [2], null, 'transactions/txn_1', {},
      function() { throw new Error('network error'); }
    );
  }, /network error/);

  assert.equal(rowStore.get(2).status, 'error');
  assert.equal(rowStore.get(2).last_error, 'network error');
});

test('saveTransactionToSheet_ clears status to empty after doctor refresh', () => {
  const rowStore = new Map([
    [2, { status: 'dirty', last_error: '' }],
    [3, { status: 'dirty', last_error: '' }],
  ]);
  const { sandbox, fakeSheet } = makeSaveTransactionSandbox(rowStore);
  sandbox.applyTransactionResponseToSheet_ = function() { return [2, 3]; };

  sandbox.saveTransactionToSheet_(fakeSheet, [2, 3], null, 'transactions/txn_1', {},
    function() { return { name: 'transactions/txn_1' }; }
  );

  assert.equal(rowStore.get(2).status, '');
  assert.equal(rowStore.get(3).status, '');
});

test('saveTransactionToSheet_ skips pre-call status writes when existingRowNumbers is null (POST)', () => {
  const rowStore = new Map([[2, { status: 'clean', last_error: '' }]]);
  const { sandbox, fakeSheet } = makeSaveTransactionSandbox(rowStore);

  sandbox.saveTransactionToSheet_(fakeSheet, null, null, null, {},
    function() { return { name: 'transactions/txn_new' }; }
  );

  // No 'saving' written before doApiCall (existingRowNumbers is null)
  // After success, status cleared on finalRowNumbers=[2] (from mock applyTransactionResponseToSheet_)
  assert.equal(rowStore.get(2).status, '');
});

test('saveTransactionToSheet_ does not write error to sheet when existingRowNumbers is null (POST failure)', () => {
  const rowStore = new Map([[2, { status: 'clean', last_error: '' }]]);
  const { sandbox, fakeSheet } = makeSaveTransactionSandbox(rowStore);

  assert.throws(function() {
    sandbox.saveTransactionToSheet_(fakeSheet, null, null, null, {},
      function() { throw new Error('server error'); }
    );
  }, /server error/);

  assert.equal(rowStore.get(2).status, 'clean');
  assert.equal(rowStore.get(2).last_error, '');
});

test('saveTransactionToSheet_ aborts cleanly when doApiCall returns null (stale generation)', () => {
  const rowStore = new Map([[2, { status: 'saving', last_error: '' }]]);
  const { sandbox, fakeSheet } = makeSaveTransactionSandbox(rowStore);

  const result = sandbox.saveTransactionToSheet_(fakeSheet, [2], null, 'transactions/txn_1', {},
    function() { return null; }
  );

  assert.equal(result, null);
  assert.equal(rowStore.get(2).status, 'saving'); // unchanged — doApiCall returned null
});

test('saveTransactionToSheet_ throws when flattenTransactionForSheet_ returns empty rows', () => {
  const rowStore = new Map([[2, { status: 'dirty', last_error: '' }]]);
  const { sandbox, fakeSheet } = makeSaveTransactionSandbox(rowStore);
  sandbox.flattenTransactionForSheet_ = function() { return []; };

  assert.throws(function() {
    sandbox.saveTransactionToSheet_(fakeSheet, [2], null, 'transactions/txn_1', {},
      function() { return { name: 'transactions/txn_1' }; }
    );
  }, /could not be rendered/);

  assert.equal(rowStore.get(2).status, 'error');
});

test('saveTransactionToSheet_ shows failure toast and still clears status when doctor refresh fails', () => {
  const rowStore = new Map([[2, { status: 'dirty', last_error: '' }]]);
  const toasts = [];
  const { sandbox, fakeSheet } = makeSaveTransactionSandbox(rowStore, {
    SpreadsheetApp: {
      getActiveSpreadsheet() {
        return { toast(message, title, seconds) { toasts.push({ message, title, seconds }); } };
      },
    },
  });
  sandbox.refreshDoctorIssueSheets_ = function() { throw new Error('doctor down'); };

  sandbox.saveTransactionToSheet_(fakeSheet, [2], null, 'transactions/txn_1', {},
    function() { return { name: 'transactions/txn_1' }; }
  );

  assert.equal(rowStore.get(2).status, '');
  assert.equal(toasts.length, 1);
  assert.match(toasts[0].message, /failed to refresh ledger doctor issues/);
});
