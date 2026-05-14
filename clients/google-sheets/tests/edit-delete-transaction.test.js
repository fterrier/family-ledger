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

test('submitTransactionFromSidebar sends correct 2-posting PATCH payload', () => {
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
  sandbox.loadAccountOptions_ = function() {
    return [{ resource_name: 'accounts/cash', display_name: '[A] Cash' }, { resource_name: 'accounts/food', display_name: '[X] Food' }];
  };
  sandbox.refreshDoctorIssueSheets_ = function() {};
  sandbox.applyAccountValidationToRowNumbers_ = function() {};
  sandbox.applyTransactionIssueFormulasToRowNumbers_ = function() {};

  sandbox.submitTransactionFromSidebar('transactions/txn_1', 2, {
    transaction_date: '2026-04-19',
    payee: 'Migros Updated',
    narration: 'Updated',
    postings: [
      { account: 'accounts/cash', units: { amount: '-84.25', symbol: 'CHF' } },
      { account: 'accounts/food', units: { amount: '84.25', symbol: 'CHF' } },
    ],
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

test('submitTransactionFromSidebar sends raw postings for 3+ posting transaction', () => {
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
  sandbox.loadAccountOptions_ = function() {
    return [
      { resource_name: 'accounts/cash', display_name: '[A] Cash' },
      { resource_name: 'accounts/food', display_name: '[X] Food' },
      { resource_name: 'accounts/coffee', display_name: '[X] Coffee' },
    ];
  };
  sandbox.refreshDoctorIssueSheets_ = function() {};
  sandbox.applyAccountValidationToRowNumbers_ = function() {};
  sandbox.applyTransactionIssueFormulasToRowNumbers_ = function() {};

  sandbox.submitTransactionFromSidebar('transactions/txn_2', 2, {
    transaction_date: '2026-04-19',
    payee: 'Updated',
    narration: 'New narration',
    postings: RAW_3_POSTINGS,
  });

  const patchCall = apiCalls.find(c => c.method === 'patch');
  assert.ok(patchCall, 'expected PATCH call');
  assert.equal(patchCall.payload.update_mask, 'transaction_date,payee,narration,postings');
  assert.deepEqual(JSON.parse(JSON.stringify(patchCall.payload.transaction.postings)), RAW_3_POSTINGS);
});

test('submitTransactionFromSidebar removes extra rows when posting count decreases', () => {
  const operations = [];
  const rowStore = new Map([
    [2, { resource_name: 'transactions/txn_2', transaction_date: '2026-04-19', payee: 'Split', narration: '', source_account_name: 'Cash', destination_account_name: 'Food', symbol: 'CHF', amount: 60, split_off_amount: '', status: '', last_error: '', issues: '', narration_source: 'txn', edit: '' }],
    [3, { resource_name: 'transactions/txn_2', transaction_date: '2026-04-19', payee: 'Split', narration: '', source_account_name: 'Cash', destination_account_name: 'Coffee', symbol: 'CHF', amount: 40, split_off_amount: '', status: '', last_error: '', issues: '', narration_source: 'txn', edit: '' }],
    [4, { resource_name: 'transactions/txn_other', transaction_date: '2026-04-20', payee: 'Other', narration: '', source_account_name: 'Cash', destination_account_name: 'Food', symbol: 'CHF', amount: 10, split_off_amount: '', status: '', last_error: '', issues: '', narration_source: 'txn', edit: '' }],
  ]);

  const { sandbox } = loadCode({
    SpreadsheetApp: { getActiveSpreadsheet() { return { toast() {}, getSheetByName() { return null; } }; } },
  });
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, operations);
  sandbox.apiFetchJson_ = function(method) {
    if (method === 'patch') {
      return makeTwoPostingTransaction({ name: 'transactions/txn_2', payee: 'Updated', narration: '' });
    }
    return {};
  };
  sandbox.getOrCreateSheet_ = function() { return fakeSheet; };
  sandbox.loadAccountOptions_ = function() {
    return [{ resource_name: 'accounts/cash', display_name: '[A] Cash' }, { resource_name: 'accounts/food', display_name: '[X] Food' }];
  };
  sandbox.refreshDoctorIssueSheets_ = function() {};
  sandbox.applyAccountValidationToRowNumbers_ = function() {};
  sandbox.applyTransactionIssueFormulasToRowNumbers_ = function() {};

  sandbox.submitTransactionFromSidebar('transactions/txn_2', 2, {
    transaction_date: '2026-04-19',
    payee: 'Updated',
    narration: '',
    postings: [
      { account: 'accounts/cash', units: { amount: '-100', symbol: 'CHF' } },
      { account: 'accounts/food', units: { amount: '100', symbol: 'CHF' } },
    ],
  });

  assert.ok(!rowStore.has(4), 'row 4 should be gone — shifted away after deleteRows');
  assert.equal(rowStore.get(2).resource_name, 'transactions/txn_2', 'txn_2 stays at row 2');
  assert.equal(rowStore.get(3).resource_name, 'transactions/txn_other', 'txn_other shifted from row 4 to row 3');
});

test('submitTransactionFromSidebar inserts extra rows when posting count increases', () => {
  const operations = [];
  const rowStore = new Map([
    [2, { resource_name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: 'Simple', narration: '', source_account_name: 'Cash', destination_account_name: 'Food', symbol: 'CHF', amount: 100, split_off_amount: '', status: '', last_error: '', issues: '', narration_source: 'txn', edit: '' }],
    [3, { resource_name: 'transactions/txn_other', transaction_date: '2026-04-20', payee: 'Other', narration: '', source_account_name: 'Cash', destination_account_name: 'Food', symbol: 'CHF', amount: 10, split_off_amount: '', status: '', last_error: '', issues: '', narration_source: 'txn', edit: '' }],
  ]);

  const { sandbox } = loadCode({
    SpreadsheetApp: { getActiveSpreadsheet() { return { toast() {}, getSheetByName() { return null; } }; } },
  });
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, operations);
  sandbox.apiFetchJson_ = function(method) {
    if (method === 'patch') {
      return { name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: 'Split', narration: '', postings: RAW_3_POSTINGS };
    }
    return {};
  };
  sandbox.getOrCreateSheet_ = function() { return fakeSheet; };
  sandbox.loadAccountOptions_ = function() {
    return [
      { resource_name: 'accounts/cash', display_name: '[A] Cash' },
      { resource_name: 'accounts/food', display_name: '[X] Food' },
      { resource_name: 'accounts/coffee', display_name: '[X] Coffee' },
    ];
  };
  sandbox.refreshDoctorIssueSheets_ = function() {};
  sandbox.applyAccountValidationToRowNumbers_ = function() {};
  sandbox.applyTransactionIssueFormulasToRowNumbers_ = function() {};

  sandbox.submitTransactionFromSidebar('transactions/txn_1', 2, {
    transaction_date: '2026-04-19',
    payee: 'Split',
    narration: '',
    postings: RAW_3_POSTINGS,
  });

  assert.equal(rowStore.get(2).resource_name, 'transactions/txn_1', 'row 2 stays txn_1');
  assert.equal(rowStore.get(3).resource_name, 'transactions/txn_1', 'new row 3 also txn_1 after expansion');
  assert.equal(rowStore.get(4).resource_name, 'transactions/txn_other', 'txn_other shifted from row 3 to row 4');
});

test('getSidebarData (edit, 2-posting) populates simple form defaults from postings', () => {
  const { sandbox } = loadCode();
  sandbox.apiFetchJson_ = function() { return makeTwoPostingTransaction(); };
  sandbox.loadAccountOptions_ = function() {
    return [{ resource_name: 'accounts/cash', display_name: 'Cash' }, { resource_name: 'accounts/food', display_name: 'Food' }];
  };
  sandbox.listCommodityOptions_ = function() { return [{ symbol: 'CHF' }, { symbol: 'EUR' }]; };

  const data = sandbox.getSidebarData('transactions/txn_1');

  assert.equal(data.configured, true);
  assert.equal(data.postingCount, 2);
  assert.equal(data.defaultSourceAccount, 'accounts/cash');
  assert.equal(data.defaultDestinationAccount, 'accounts/food');
  assert.equal(data.defaultAmount, 84.25);
  assert.equal(data.defaultSymbol, 'CHF');
  assert.equal(data.defaultDate, '2026-04-19');
  assert.equal(data.defaultPayee, 'Migros');
  assert.equal(data.allAccountOptions.length, 2);
  assert.equal(data.allCommodityOptions.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(data.rawPostings)), makeTwoPostingTransaction().postings);
});

test('getSidebarData (edit, 1-posting) populates source account, amount and symbol with no destination', () => {
  const { sandbox } = loadCode();
  sandbox.apiFetchJson_ = function() {
    return {
      name: 'transactions/txn_1',
      transaction_date: '2026-04-19',
      payee: 'ATM',
      narration: '',
      postings: [
        { account: 'accounts/cash', units: { amount: '-50', symbol: 'CHF' } },
      ],
    };
  };
  sandbox.loadAccountOptions_ = function() {
    return [{ resource_name: 'accounts/cash', display_name: 'Cash' }];
  };
  sandbox.listCommodityOptions_ = function() { return [{ symbol: 'CHF' }]; };

  const data = sandbox.getSidebarData('transactions/txn_1');

  assert.equal(data.postingCount, 1);
  assert.equal(data.defaultSourceAccount, 'accounts/cash');
  assert.equal(data.defaultDestinationAccount, null);
  assert.equal(data.defaultAmount, 50);
  assert.equal(data.defaultSymbol, 'CHF');
});

test('getSidebarData (edit, 3-posting) returns rawPostings and clears simple form defaults', () => {
  const { sandbox } = loadCode();
  sandbox.apiFetchJson_ = function() {
    return { name: 'transactions/txn_2', transaction_date: '2026-04-20', payee: 'Split', narration: '', postings: RAW_3_POSTINGS };
  };
  sandbox.loadAccountOptions_ = function() { return []; };
  sandbox.listCommodityOptions_ = function() { return [{ symbol: 'CHF' }]; };

  const data = sandbox.getSidebarData('transactions/txn_2');

  assert.equal(data.postingCount, 3);
  assert.equal(data.defaultSourceAccount, null);
  assert.equal(data.defaultDestinationAccount, null);
  assert.equal(data.defaultAmount, null);
  assert.equal(data.defaultSymbol, null);
  assert.deepEqual(JSON.parse(JSON.stringify(data.rawPostings)), RAW_3_POSTINGS);
});
