const test = require('node:test');
const assert = require('node:assert/strict');

const { loadCode, makeRowStoreSheet_ } = require('./_harness');

test('findInsertionRowForTransactionDate_ inserts before first greater date and after same-date block', () => {
  const rowStore = new Map([
    [2, { resource_name: 'transactions/txn_1', transaction_date: '2026-04-18' }],
    [3, { resource_name: 'transactions/txn_2', transaction_date: '2026-04-19' }],
    [4, { resource_name: 'transactions/txn_3', transaction_date: '2026-04-19' }],
    [5, { resource_name: 'transactions/txn_4', transaction_date: '2026-04-21' }],
  ]);
  const { sandbox } = loadCode();
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, []);

  assert.equal(sandbox.findInsertionRowForTransactionDate_(fakeSheet, '2026-04-17'), 2);
  assert.equal(sandbox.findInsertionRowForTransactionDate_(fakeSheet, '2026-04-19'), 5);
  assert.equal(sandbox.findInsertionRowForTransactionDate_(fakeSheet, '2026-04-20'), 5);
  assert.equal(sandbox.findInsertionRowForTransactionDate_(fakeSheet, '2026-04-22'), 6);
});

test('submitTransactionFromSidebar (add) inserts new row before a later transaction', () => {
  const rowStore = new Map([
    [2, { resource_name: 'transactions/txn_1', transaction_date: '2026-04-19' }],
    [3, { resource_name: 'transactions/txn_2', transaction_date: '2026-04-21' }],
  ]);
  const { sandbox, documentProperties } = loadCode({
    SpreadsheetApp: {
      getActiveSpreadsheet() {
        return { toast() {}, setActiveSheet() {}, getSheetByName() { return null; } };
      },
    },
  });
  documentProperties.set('QUICK_ADD_SOURCE_ACCOUNTS', '["accounts/cash"]');
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, []);
  sandbox.apiFetchJson_ = function(method) {
    if (method === 'post') {
      return {
        name: 'transactions/txn_new',
        transaction_date: '2026-04-20',
        payee: 'New',
        narration: '',
        postings: [{ account: 'accounts/cash', units: { amount: '-12', symbol: 'CHF' } }],
      };
    }
    return {};
  };
  sandbox.getOrCreateSheet_ = function() { return fakeSheet; };
  sandbox.loadAccountOptions_ = function() { return [{ resource_name: 'accounts/cash', display_name: '[A] Cash' }]; };
  sandbox.refreshDoctorIssueSheets_ = function() {};
  sandbox.applyAccountValidationToSpan_ = function() {};
  sandbox.focusCell_ = function() {};

  const result = sandbox.submitTransactionFromSidebar(null, null, {
    transaction_date: '2026-04-20',
    payee: 'New',
    narration: '',
    postings: [{ account: 'accounts/cash', units: { amount: '-12', symbol: 'CHF' } }],
  });

  assert.deepEqual(JSON.parse(JSON.stringify(result.span)), { start: 3, count: 1 });
  assert.equal(rowStore.get(3).resource_name, 'transactions/txn_new');
  assert.equal(rowStore.get(4).resource_name, 'transactions/txn_2');
});

test('submitTransactionFromSidebar (edit) writes error status to sheet row on PATCH failure', () => {
  const rowStore = new Map([
    [2, {
      resource_name: 'transactions/txn_1',
      transaction_date: '2026-04-19',
      payee: 'Migros',
      narration: 'Groceries',
      source_account_name: '[A] Cash',
      destination_account_name: '[X] Food',
      amount: 12,
      symbol: 'CHF',
      status: 'dirty',
      last_error: '',
      split_off_amount: '',
      issues: '',
    }],
  ]);
  const { sandbox } = loadCode({
    SpreadsheetApp: {
      getActiveSpreadsheet() { return { toast() {} }; },
      getUi() { return { alert() {}, ButtonSet: { OK: 0 } }; },
    },
  });
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, []);
  sandbox.getOrCreateSheet_ = function() { return fakeSheet; };
  sandbox.loadAccountOptions_ = function() {
    return [{ resource_name: 'accounts/cash', display_name: '[A] Cash' }];
  };
  sandbox.findTransactionRowNumbersFromAnchor_ = function() {
    return { span: { start: 2, count: 1 } };
  };
  sandbox.apiFetchJson_ = function() {
    throw new Error('transaction_unbalanced: not balanced');
  };

  // runUserAction_ catches and swallows errors (shows alert, returns null)
  const result = sandbox.submitTransactionFromSidebar('transactions/txn_1', 2, {
    transaction_date: '2026-04-19',
    payee: 'Migros',
    narration: 'Groceries',
    postings: [{ account: 'accounts/cash', units: { amount: '-12', symbol: 'CHF' } }],
  });

  assert.equal(result, null);
  assert.equal(rowStore.get(2).status, 'error');
  assert.match(rowStore.get(2).last_error, /transaction_unbalanced/);
});

test('getSidebarData (add mode) returns shortlist-filtered accounts for simple form and all accounts for advanced', () => {
  const { sandbox, documentProperties } = loadCode();
  documentProperties.set('QUICK_ADD_SOURCE_ACCOUNTS', '["accounts/cash"]');
  documentProperties.set('QUICK_ADD_DESTINATION_ACCOUNTS', '["accounts/food"]');
  documentProperties.set('QUICK_ADD_SYMBOLS', '["CHF"]');

  sandbox.loadAccountOptions_ = function() {
    return [
      { resource_name: 'accounts/cash', display_name: 'Cash' },
      { resource_name: 'accounts/food', display_name: 'Food' },
      { resource_name: 'accounts/other', display_name: 'Other' },
    ];
  };
  sandbox.listCommodityOptions_ = function() {
    return [{ symbol: 'CHF' }, { symbol: 'EUR' }];
  };

  const data = sandbox.getSidebarData(null);

  assert.equal(data.configured, true);
  assert.equal(data.postingCount, null);
  // Simple form uses shortlist-filtered options
  assert.deepEqual(data.sourceAccountOptions.map(function(o) { return o.resource_name; }), ['accounts/cash']);
  assert.deepEqual(data.destinationAccountOptions.map(function(o) { return o.resource_name; }), ['accounts/food']);
  assert.deepEqual(data.commodityOptions.map(function(o) { return o.symbol; }), ['CHF']);
  // Advanced mode uses all unfiltered options
  assert.equal(data.allAccountOptions.length, 3);
  assert.equal(data.allCommodityOptions.length, 2);
});
