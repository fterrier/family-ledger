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

const RAW_3_POSTINGS = [
  { account: 'accounts/cash', units: { amount: '-100', symbol: 'CHF' } },
  { account: 'accounts/food', units: { amount: '60', symbol: 'CHF' } },
  { account: 'accounts/coffee', units: { amount: '40', symbol: 'CHF' } },
];

// --- getSidebarData ---

test('getSidebarData (add mode) returns mode and fields with inline selection-options', () => {
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

  const data = sandbox.getSidebarData({ classKey: 'transactions', name: null });

  assert.equal(data.mode, 'simple');
  assert.equal(data.allowModeSwitch, true);
  assert.ok(!('options' in data), 'no top-level options key');
  assert.ok(Array.isArray(data.fields));
  assert.ok(data.fields.some(function(f) { return f.type === 'date'; }));

  const srcField = data.fields.find(function(f) { return f.key === 'source_account'; });
  assert.deepEqual(srcField['selection-options'].map(function(o) { return o.value; }), ['accounts/cash']);

  const dstField = data.fields.find(function(f) { return f.key === 'destination_account'; });
  assert.deepEqual(dstField['selection-options'].map(function(o) { return o.value; }), ['accounts/food']);

  const symField = data.fields.find(function(f) { return f.key === 'symbol'; });
  assert.deepEqual(symField['selection-options'].map(function(o) { return o.value; }), ['CHF']);
});

test('getSidebarData (edit, 2-posting) returns simple mode with classified fields', () => {
  const { sandbox } = loadCode();
  sandbox.apiFetchJson_ = function() { return makeTwoPostingTransaction(); };
  sandbox.loadAccountOptions_ = function() {
    return [{ resource_name: 'accounts/cash', display_name: 'Cash' }, { resource_name: 'accounts/food', display_name: 'Food' }];
  };
  sandbox.listCommodityOptions_ = function() { return [{ symbol: 'CHF' }, { symbol: 'EUR' }]; };

  const data = sandbox.getSidebarData({ classKey: 'transactions', name: 'transactions/txn_1' });

  assert.equal(data.mode, 'simple');
  assert.equal(data.allowModeSwitch, true);
  assert.ok(!('options' in data), 'no top-level options key');

  const dateField = data.fields.find(function(f) { return f.key === 'transaction_date'; });
  assert.equal(dateField.default, '2026-04-19');

  const payeeField = data.fields.find(function(f) { return f.key === 'payee'; });
  assert.equal(payeeField.default, 'Migros');

  const srcField = data.fields.find(function(f) { return f.key === 'source_account'; });
  assert.equal(srcField.default, 'accounts/cash');
  assert.equal(srcField['selection-options'].length, 2);

  const dstField = data.fields.find(function(f) { return f.key === 'destination_account'; });
  assert.equal(dstField.default, 'accounts/food');

  const amtField = data.fields.find(function(f) { return f.key === 'amount'; });
  assert.equal(amtField.default, 84.25);

  const symField = data.fields.find(function(f) { return f.key === 'symbol'; });
  assert.equal(symField.default, 'CHF');
  assert.equal(symField['selection-options'].length, 2);
});

test('getSidebarData (edit, source-only with negative posting) defaults to positive amount in simple mode', () => {
  const { sandbox } = loadCode();
  sandbox.apiFetchJson_ = function() {
    return {
      name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: '', narration: '',
      postings: [{ account: 'accounts/cash', units: { amount: '-84.25', symbol: 'CHF' } }],
    };
  };
  sandbox.loadAccountOptions_ = function() { return [{ resource_name: 'accounts/cash', display_name: 'Cash' }]; };
  sandbox.listCommodityOptions_ = function() { return [{ symbol: 'CHF' }]; };

  const data = sandbox.getSidebarData({ classKey: 'transactions', name: 'transactions/txn_1' });

  assert.equal(data.mode, 'simple');
  const amtField = data.fields.find(function(f) { return f.key === 'amount'; });
  assert.equal(amtField.default, 84.25);
});

test('getSidebarData (edit, source-only with positive posting) defaults to negative amount in simple mode', () => {
  // Income/equity: posting=+5524.65 → sheet shows -5524.65 → simple mode must match the sheet
  const { sandbox } = loadCode();
  sandbox.apiFetchJson_ = function() {
    return {
      name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: '', narration: '',
      postings: [{ account: 'accounts/savings', units: { amount: '5524.65', symbol: 'CHF' } }],
    };
  };
  sandbox.loadAccountOptions_ = function() { return [{ resource_name: 'accounts/savings', display_name: 'Savings' }]; };
  sandbox.listCommodityOptions_ = function() { return [{ symbol: 'CHF' }]; };

  const data = sandbox.getSidebarData({ classKey: 'transactions', name: 'transactions/txn_1' });

  assert.equal(data.mode, 'simple');
  const amtField = data.fields.find(function(f) { return f.key === 'amount'; });
  assert.equal(amtField.default, -5524.65);
});

test('getSidebarData (edit, 3-posting) returns advanced mode with postings field', () => {
  const { sandbox } = loadCode();
  sandbox.apiFetchJson_ = function() {
    return { name: 'transactions/txn_2', transaction_date: '2026-04-20', payee: 'Split', narration: '', postings: RAW_3_POSTINGS };
  };
  sandbox.loadAccountOptions_ = function() { return []; };
  sandbox.listCommodityOptions_ = function() { return [{ symbol: 'CHF' }]; };

  const data = sandbox.getSidebarData({ classKey: 'transactions', name: 'transactions/txn_2' });

  assert.equal(data.mode, 'advanced');
  assert.equal(data.allowModeSwitch, true);
  assert.ok(!('options' in data), 'no top-level options key');

  const postingsField = data.fields.find(function(f) { return f.type === 'postings'; });
  assert.ok(postingsField, 'postings field present');
  assert.equal(postingsField.default.length, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(postingsField.default)), RAW_3_POSTINGS);
  assert.ok(Array.isArray(postingsField['account-options']));
  assert.ok(Array.isArray(postingsField['commodity-options']));
  assert.equal(postingsField['commodity-options'].length, 1);
});

test('getSidebarData for non-Transaction entity does not set allowModeSwitch', () => {
  const { sandbox } = loadCode();

  const data = sandbox.getSidebarData({ classKey: 'accounts', name: null });

  assert.ok(!data.allowModeSwitch, 'allowModeSwitch should be falsy for Account');
});

// --- mode switching (server side of onToggleMode) ---

test('getSidebarData (add, simple→advanced) passes currentPostings into postings field and keeps text defaults null', () => {
  const { sandbox } = loadCode();
  sandbox.loadAccountOptions_ = function() {
    return [{ resource_name: 'accounts/cash', display_name: 'Cash' }];
  };
  sandbox.listCommodityOptions_ = function() { return [{ symbol: 'CHF' }]; };

  const simplePostings = [
    { account: 'accounts/cash', units: { amount: '-50', symbol: 'CHF' } },
  ];

  const data = sandbox.getSidebarData({ classKey: 'transactions', name: null }, 'advanced', simplePostings);

  assert.equal(data.mode, 'advanced');
  assert.equal(data.allowModeSwitch, true);

  // Text field defaults are null in add mode (values are preserved client-side)
  const dateField = data.fields.find(function(f) { return f.key === 'transaction_date'; });
  assert.equal(dateField.default, null);
  const payeeField = data.fields.find(function(f) { return f.key === 'payee'; });
  assert.equal(payeeField.default, null);
  const narrationField = data.fields.find(function(f) { return f.key === 'narration'; });
  assert.equal(narrationField.default, null);

  const postingsField = data.fields.find(function(f) { return f.type === 'postings'; });
  assert.ok(postingsField, 'postings field present');
  assert.deepEqual(JSON.parse(JSON.stringify(postingsField.default)), simplePostings);
});

test('getSidebarData (add, advanced→simple) classifies currentPostings back to simple form', () => {
  const { sandbox } = loadCode();
  sandbox.loadAccountOptions_ = function() {
    return [
      { resource_name: 'accounts/cash', display_name: 'Cash' },
      { resource_name: 'accounts/food', display_name: 'Food' },
    ];
  };
  sandbox.listCommodityOptions_ = function() { return [{ symbol: 'CHF' }]; };

  const advancedPostings = [
    { account: 'accounts/cash', units: { amount: '-84.25', symbol: 'CHF' } },
    { account: 'accounts/food', units: { amount: '84.25', symbol: 'CHF' } },
  ];

  const data = sandbox.getSidebarData({ classKey: 'transactions', name: null }, 'simple', advancedPostings);

  assert.equal(data.mode, 'simple');

  const srcField = data.fields.find(function(f) { return f.key === 'source_account'; });
  assert.equal(srcField.default, 'accounts/cash');
  const dstField = data.fields.find(function(f) { return f.key === 'destination_account'; });
  assert.equal(dstField.default, 'accounts/food');
  const amtField = data.fields.find(function(f) { return f.key === 'amount'; });
  assert.equal(amtField.default, 84.25);
});

test('getSidebarData (edit, advanced mode) uses currentPostings when provided instead of API postings', () => {
  const { sandbox } = loadCode();
  const apiPostings = [
    { account: 'accounts/cash', units: { amount: '-100', symbol: 'CHF' } },
    { account: 'accounts/food', units: { amount: '100', symbol: 'CHF' } },
  ];
  const clientPostings = [
    { account: 'accounts/cash', units: { amount: '-50', symbol: 'CHF' } },
    { account: 'accounts/food', units: { amount: '50', symbol: 'CHF' } },
  ];
  sandbox.apiFetchJson_ = function() {
    return { name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: 'Migros', narration: 'Groceries', postings: apiPostings };
  };
  sandbox.loadAccountOptions_ = function() {
    return [{ resource_name: 'accounts/cash', display_name: 'Cash' }, { resource_name: 'accounts/food', display_name: 'Food' }];
  };
  sandbox.listCommodityOptions_ = function() { return [{ symbol: 'CHF' }]; };

  const data = sandbox.getSidebarData({ classKey: 'transactions', name: 'transactions/txn_1' }, 'advanced', clientPostings);

  assert.equal(data.mode, 'advanced');

  // Text field defaults still come from the API (edit mode)
  const dateField = data.fields.find(function(f) { return f.key === 'transaction_date'; });
  assert.equal(dateField.default, '2026-04-19');
  const payeeField = data.fields.find(function(f) { return f.key === 'payee'; });
  assert.equal(payeeField.default, 'Migros');

  const postingsField = data.fields.find(function(f) { return f.type === 'postings'; });
  assert.deepEqual(JSON.parse(JSON.stringify(postingsField.default)), clientPostings);
});

// --- submitEntity ---

test('submitEntity (add) inserts new row before a later transaction', () => {
  const rowStore = new Map([
    [2, { resource_name: 'transactions/txn_1', transaction_date: '2026-04-19' }],
    [3, { resource_name: 'transactions/txn_2', transaction_date: '2026-04-21' }],
  ]);
  const { sandbox, documentProperties } = loadCode({
    SpreadsheetApp: {
      getActiveSpreadsheet() {
        return { toast() {}, setActiveSheet() {}, getSheetByName() { return null; }, getSpreadsheetTimeZone() { return 'UTC'; } };
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

  const result = sandbox.submitEntity({ classKey: 'transactions', name: null, span: null }, {
    transaction_date: '2026-04-20',
    payee: 'New',
    narration: '',
    source_account: 'accounts/cash',
    amount: '12',
    symbol: 'CHF',
  });

  assert.deepEqual(JSON.parse(JSON.stringify(result.span)), { start: 3, count: 1 });
  assert.equal(rowStore.get(3).resource_name, 'transactions/txn_new');
  assert.equal(rowStore.get(4).resource_name, 'transactions/txn_2');
});

test('submitEntity (edit) shows toast and returns null on PATCH failure', () => {
  const toasts = [];
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
      split_off_amount: '',
      issues: '',
    }],
  ]);
  const { sandbox } = loadCode({
    SpreadsheetApp: {
      getActiveSpreadsheet() { return { toast(message, title, seconds) { toasts.push({ message, title, seconds }); }, getSpreadsheetTimeZone() { return 'UTC'; } }; },
      getUi() { return { alert() {}, ButtonSet: { OK: 0 } }; },
    },
  });
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, []);
  sandbox.getOrCreateSheet_ = function() { return fakeSheet; };
  sandbox.loadAccountOptions_ = function() {
    return [{ resource_name: 'accounts/cash', display_name: '[A] Cash' }];
  };
  sandbox.apiFetchJson_ = function() {
    throw new Error('transaction_unbalanced: not balanced');
  };

  const result = sandbox.submitEntity({ classKey: 'transactions', name: 'transactions/txn_1', span: { start: 2, count: 1 } }, {
    transaction_date: '2026-04-19',
    payee: 'Migros',
    narration: 'Groceries',
    postings: [{ account: 'accounts/cash', units: { amount: '-12', symbol: 'CHF' } }],
  });

  assert.equal(result, null);
});

test('submitEntity (edit) sends correct 2-posting PATCH payload', () => {
  const operations = [];
  const rowStore = new Map([
    [2, { resource_name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: 'Old', narration: '', source_account_name: 'Cash', destination_account_name: 'Food', symbol: 'CHF', amount: 84.25, split_off_amount: '', status: '', last_error: '', issues: '', narration_source: 'txn', edit: '' }],
  ]);

  const apiCalls = [];
  const { sandbox } = loadCode({
    SpreadsheetApp: { getActiveSpreadsheet() { return { toast() {}, getSheetByName() { return null; }, getSpreadsheetTimeZone() { return 'UTC'; } }; } },
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
  sandbox.applyAccountValidationToSpan_ = function() {};

  sandbox.submitEntity({ classKey: 'transactions', name: 'transactions/txn_1', span: { start: 2, count: 1 } }, {
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

test('submitEntity (edit) sends raw postings for 3+ posting transaction', () => {
  const operations = [];
  const rowStore = new Map([
    [2, { resource_name: 'transactions/txn_2', transaction_date: '2026-04-19', payee: 'Split', narration: '', source_account_name: 'Cash', destination_account_name: 'Food', symbol: 'CHF', amount: 60, split_off_amount: '', status: '', last_error: '', issues: '', narration_source: 'txn', edit: '' }],
    [3, { resource_name: 'transactions/txn_2', transaction_date: '2026-04-19', payee: 'Split', narration: '', source_account_name: 'Cash', destination_account_name: 'Coffee', symbol: 'CHF', amount: 40, split_off_amount: '', status: '', last_error: '', issues: '', narration_source: 'txn', edit: '' }],
  ]);

  const apiCalls = [];
  const { sandbox } = loadCode({
    SpreadsheetApp: { getActiveSpreadsheet() { return { toast() {}, getSheetByName() { return null; }, getSpreadsheetTimeZone() { return 'UTC'; } }; } },
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
  sandbox.applyAccountValidationToSpan_ = function() {};

  sandbox.submitEntity({ classKey: 'transactions', name: 'transactions/txn_2', span: { start: 2, count: 2 } }, {
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

test('submitEntity (edit) removes extra rows when posting count decreases', () => {
  const operations = [];
  const rowStore = new Map([
    [2, { resource_name: 'transactions/txn_2', transaction_date: '2026-04-19', payee: 'Split', narration: '', source_account_name: 'Cash', destination_account_name: 'Food', symbol: 'CHF', amount: 60, split_off_amount: '', status: '', last_error: '', issues: '', narration_source: 'txn', edit: '' }],
    [3, { resource_name: 'transactions/txn_2', transaction_date: '2026-04-19', payee: 'Split', narration: '', source_account_name: 'Cash', destination_account_name: 'Coffee', symbol: 'CHF', amount: 40, split_off_amount: '', status: '', last_error: '', issues: '', narration_source: 'txn', edit: '' }],
    [4, { resource_name: 'transactions/txn_other', transaction_date: '2026-04-20', payee: 'Other', narration: '', source_account_name: 'Cash', destination_account_name: 'Food', symbol: 'CHF', amount: 10, split_off_amount: '', status: '', last_error: '', issues: '', narration_source: 'txn', edit: '' }],
  ]);

  const { sandbox } = loadCode({
    SpreadsheetApp: { getActiveSpreadsheet() { return { toast() {}, getSheetByName() { return null; }, getSpreadsheetTimeZone() { return 'UTC'; } }; } },
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
  sandbox.applyAccountValidationToSpan_ = function() {};

  sandbox.submitEntity({ classKey: 'transactions', name: 'transactions/txn_2', span: { start: 2, count: 2 } }, {
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

test('submitEntity (edit) inserts extra rows when posting count increases', () => {
  const operations = [];
  const rowStore = new Map([
    [2, { resource_name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: 'Simple', narration: '', source_account_name: 'Cash', destination_account_name: 'Food', symbol: 'CHF', amount: 100, split_off_amount: '', status: '', last_error: '', issues: '', narration_source: 'txn', edit: '' }],
    [3, { resource_name: 'transactions/txn_other', transaction_date: '2026-04-20', payee: 'Other', narration: '', source_account_name: 'Cash', destination_account_name: 'Food', symbol: 'CHF', amount: 10, split_off_amount: '', status: '', last_error: '', issues: '', narration_source: 'txn', edit: '' }],
  ]);

  const { sandbox } = loadCode({
    SpreadsheetApp: { getActiveSpreadsheet() { return { toast() {}, getSheetByName() { return null; }, getSpreadsheetTimeZone() { return 'UTC'; } }; } },
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
  sandbox.applyAccountValidationToSpan_ = function() {};

  sandbox.submitEntity({ classKey: 'transactions', name: 'transactions/txn_1', span: { start: 2, count: 1 } }, {
    transaction_date: '2026-04-19',
    payee: 'Split',
    narration: '',
    postings: RAW_3_POSTINGS,
  });

  assert.equal(rowStore.get(2).resource_name, 'transactions/txn_1', 'row 2 stays txn_1');
  assert.equal(rowStore.get(3).resource_name, 'transactions/txn_1', 'new row 3 also txn_1 after expansion');
  assert.equal(rowStore.get(4).resource_name, 'transactions/txn_other', 'txn_other shifted from row 3 to row 4');
});

// --- deleteEntity ---

test('deleteEntity calls DELETE and removes rows from sheet', () => {
  const operations = [];
  const rowStore = new Map([
    [2, { resource_name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: 'Migros', narration: '' }],
    [3, { resource_name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: 'Migros', narration: '' }],
    [4, { resource_name: 'transactions/txn_2', transaction_date: '2026-04-20', payee: 'Other', narration: '' }],
  ]);

  const apiCalls = [];
  const { sandbox } = loadCode({
    SpreadsheetApp: { getActiveSpreadsheet() { return { toast() {}, getSheetByName() { return null; }, getSpreadsheetTimeZone() { return 'UTC'; } }; } },
  });
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, operations);
  sandbox.apiFetchJson_ = function(method, path) {
    apiCalls.push({ method, path });
    return {};
  };
  sandbox.getOrCreateSheet_ = function() { return fakeSheet; };
  sandbox.loadAccountOptions_ = function() { return []; };
  sandbox.refreshDoctorIssueSheets_ = function() {};

  sandbox.deleteEntity({ classKey: 'transactions', name: 'transactions/txn_1', span: { start: 2, count: 2 } });

  assert.ok(apiCalls.some(c => c.method === 'delete' && c.path === '/transactions/txn_1'), 'expected DELETE call');
  assert.ok(!rowStore.has(3), 'row 3 should be gone after deletion and shift');
  assert.ok(!rowStore.has(4), 'original row 4 should have shifted away');
  assert.equal(rowStore.get(2).resource_name, 'transactions/txn_2', 'txn_2 should shift to row 2');
});
