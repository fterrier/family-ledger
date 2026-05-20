const test = require('node:test');
const assert = require('node:assert/strict');

const { loadCode, makeRowStoreSheet_ } = require('./_harness');

function makeBalanceApi(overrides) {
  return Object.assign({
    name: 'balanceAssertions/bal_1',
    assertion_date: '2026-04-19',
    account: 'accounts/checking',
    amount: { amount: '1000.00', symbol: 'CHF' },
  }, overrides);
}

function getBalance(sandbox) {
  return sandbox.ENTITY_REGISTRY['Balances'];
}

function makeBalanceSheet_(sandbox, rowStore, operations) {
  return makeRowStoreSheet_(sandbox, rowStore, operations, 'Balances');
}

// --- Balance.fromApi / toApiPayload_ / validate ---

test('Balance.fromApi produces correct _api shape', () => {
  const { sandbox } = loadCode();
  const ctx = { accountResourceToDisplayName: { 'accounts/checking': '[A] Checking' } };
  const b = getBalance(sandbox).fromApi(makeBalanceApi(), ctx);

  assert.equal(b.getName(), 'balanceAssertions/bal_1');
  assert.equal(b._api.assertion_date, '2026-04-19');
  assert.equal(b._api.account, 'accounts/checking');
  assert.deepEqual(b._api.amount, { amount: '1000.00', symbol: 'CHF' });
});

test('Balance.toApiPayload_ excludes name, edit, issues', () => {
  const { sandbox } = loadCode();
  const b = getBalance(sandbox).fromApi(makeBalanceApi());
  const payload = b.toApiPayload_();

  assert.ok(!('name' in payload));
  assert.ok(!('edit' in payload));
  assert.ok(!('issues' in payload));
  assert.equal(payload.assertion_date, '2026-04-19');
  assert.equal(payload.account, 'accounts/checking');
  assert.deepEqual(payload.amount, { amount: '1000.00', symbol: 'CHF' });
});

test('Balance.validate throws when assertion_date is missing', () => {
  const { sandbox } = loadCode();
  const b = getBalance(sandbox).fromApi(makeBalanceApi({ assertion_date: null }));
  assert.throws(function() { b.validate(); }, /date/i);
});

test('Balance.validate throws when account is missing', () => {
  const { sandbox } = loadCode();
  const b = getBalance(sandbox).fromApi(makeBalanceApi({ account: null }));
  assert.throws(function() { b.validate(); }, /account/i);
});

test('Balance.validate throws when amount is missing', () => {
  const { sandbox } = loadCode();
  const b = getBalance(sandbox).fromApi(makeBalanceApi({ amount: { amount: null, symbol: 'CHF' } }));
  assert.throws(function() { b.validate(); }, /amount/i);
});

test('Balance.validate throws when symbol is missing', () => {
  const { sandbox } = loadCode();
  const b = getBalance(sandbox).fromApi(makeBalanceApi({ amount: { amount: '100', symbol: null } }));
  assert.throws(function() { b.validate(); }, /symbol/i);
});

// --- Balance.fromRows ---

test('Balance.fromRows reconstructs _api from sheet row', () => {
  const { sandbox } = loadCode();
  const ctx = {
    accountResourceToDisplayName: { 'accounts/checking': '[A] Checking' },
    accountDisplayNameToResource: { '[A] Checking': 'accounts/checking' },
  };
  const rows = [{ resource_name: 'balanceAssertions/bal_1', assertion_date: '2026-04-19', account: '[A] Checking', amount: 1000, symbol: 'CHF' }];
  const b = getBalance(sandbox).fromRows(rows, ctx, { start: 2, count: 1 });

  assert.equal(b._api.name, 'balanceAssertions/bal_1');
  assert.equal(b._api.assertion_date, '2026-04-19');
  assert.equal(b._api.account, 'accounts/checking');
  assert.equal(b._api.amount.amount, '1000');
  assert.equal(b._api.amount.symbol, 'CHF');
  assert.deepEqual(b._span, { start: 2, count: 1 });
});

// --- applyBalanceResponseToSheet_ ---

test('applyBalanceResponseToSheet_ inserts new assertion at date-sorted position', () => {
  const { sandbox } = loadCode();
  const ctx = { accountResourceToDisplayName: { 'accounts/checking': '[A] Checking' } };
  const rowStore = new Map([
    [2, { resource_name: 'balanceAssertions/bal_0', assertion_date: '2026-04-10', account: '[A] Checking', amount: 500, symbol: 'CHF', edit: false, issues: '' }],
    [3, { resource_name: 'balanceAssertions/bal_2', assertion_date: '2026-04-25', account: '[A] Checking', amount: 2000, symbol: 'CHF', edit: false, issues: '' }],
  ]);
  const sheet = makeBalanceSheet_(sandbox, rowStore, []);
  sandbox.SpreadsheetApp.getActiveSpreadsheet = function() { return { getSheetByName() { return null; } }; };

  const b = getBalance(sandbox).fromApi(makeBalanceApi(), ctx);
  const span = sandbox.applyBalanceResponseToSheet_(sheet, null, b.toRows_());

  assert.equal(rowStore.get(2).resource_name, 'balanceAssertions/bal_0');
  assert.equal(rowStore.get(3).resource_name, 'balanceAssertions/bal_1');
  assert.equal(rowStore.get(4).resource_name, 'balanceAssertions/bal_2');
  assert.deepEqual(JSON.parse(JSON.stringify(span)), { start: 3, count: 1 });
});

test('applyBalanceResponseToSheet_ appends new assertion when date is after all existing', () => {
  const { sandbox } = loadCode();
  const rowStore = new Map([
    [2, { resource_name: 'balanceAssertions/bal_0', assertion_date: '2026-04-10', account: '[A] Checking', amount: 500, symbol: 'CHF', edit: false, issues: '' }],
  ]);
  const sheet = makeBalanceSheet_(sandbox, rowStore, []);

  const b = getBalance(sandbox).fromApi(makeBalanceApi({ assertion_date: '2026-05-01' }), {});
  const span = sandbox.applyBalanceResponseToSheet_(sheet, null, b.toRows_());

  assert.equal(rowStore.size, 2);
  assert.equal(rowStore.get(3).resource_name, 'balanceAssertions/bal_1');
  assert.deepEqual(JSON.parse(JSON.stringify(span)), { start: 3, count: 1 });
});

test('applyBalanceResponseToSheet_ writes to row 2 when sheet is empty', () => {
  const { sandbox } = loadCode();
  const rowStore = new Map();
  const sheet = makeBalanceSheet_(sandbox, rowStore, []);

  const b = getBalance(sandbox).fromApi(makeBalanceApi(), {});
  const span = sandbox.applyBalanceResponseToSheet_(sheet, null, b.toRows_());

  assert.equal(rowStore.get(2).resource_name, 'balanceAssertions/bal_1');
  assert.deepEqual(JSON.parse(JSON.stringify(span)), { start: 2, count: 1 });
});

test('applyBalanceResponseToSheet_ replaces row in-place when existingSpan provided', () => {
  const { sandbox } = loadCode();
  const rowStore = new Map([
    [2, { resource_name: 'balanceAssertions/bal_1', assertion_date: '2026-04-19', account: '[A] Checking', amount: 500, symbol: 'CHF', edit: false, issues: '' }],
    [3, { resource_name: 'balanceAssertions/bal_2', assertion_date: '2026-04-25', account: '[A] Checking', amount: 2000, symbol: 'CHF', edit: false, issues: '' }],
  ]);
  const sheet = makeBalanceSheet_(sandbox, rowStore, []);

  const updated = getBalance(sandbox).fromApi(makeBalanceApi({ amount: { amount: '1500.00', symbol: 'CHF' } }), {});
  const span = sandbox.applyBalanceResponseToSheet_(sheet, { start: 2, count: 1 }, updated.toRows_());

  assert.equal(rowStore.size, 2);
  assert.equal(rowStore.get(2).amount, '1500.00');
  assert.equal(rowStore.get(3).resource_name, 'balanceAssertions/bal_2');
  assert.deepEqual(JSON.parse(JSON.stringify(span)), { start: 2, count: 1 });
});

// --- scanEntityRows_(Balance) ---

test('scanEntityRows_(Balance) finds a single row from anchor', () => {
  const { sandbox } = loadCode();
  const rowStore = new Map([
    [2, { resource_name: 'balanceAssertions/bal_1', assertion_date: '2026-04-19', account: '[A] Checking', amount: 1000, symbol: 'CHF', edit: false, issues: '' }],
  ]);
  const sheet = makeBalanceSheet_(sandbox, rowStore, []);
  const ctx = { accountDisplayNameToResource: { '[A] Checking': 'accounts/checking' } };
  sandbox.loadAccountOptions_ = function() { return [{ resource_name: 'accounts/checking', display_name: '[A] Checking' }]; };

  const entity = sandbox.findEntityRowsFromAnchor_(getBalance(sandbox), sheet, 2);

  assert.equal(entity.getName(), 'balanceAssertions/bal_1');
  assert.deepEqual(JSON.parse(JSON.stringify(entity._span)), { start: 2, count: 1 });
});

test('scanEntityRows_(Balance) throws when anchor row has no resource_name', () => {
  const { sandbox } = loadCode();
  const rowStore = new Map([
    [2, { resource_name: '', assertion_date: '2026-04-19', account: '', amount: '', symbol: '', edit: false, issues: '' }],
  ]);
  const sheet = makeBalanceSheet_(sandbox, rowStore, []);
  sandbox.loadAccountOptions_ = function() { return []; };

  assert.throws(function() {
    sandbox.findEntityRowsFromAnchor_(getBalance(sandbox), sheet, 2);
  }, /balance assertion/i);
});

// --- getSidebarData ---

test('getSidebarData (add mode) returns mode advanced and 4 fields', () => {
  const { sandbox } = loadCode();
  sandbox.loadAccountOptions_ = function() {
    return [
      { resource_name: 'accounts/checking', display_name: '[A] Checking' },
      { resource_name: 'accounts/savings', display_name: '[A] Savings' },
    ];
  };
  sandbox.listCommodityOptions_ = function() { return [{ symbol: 'CHF' }, { symbol: 'EUR' }]; };

  const data = sandbox.getSidebarData({ classKey: 'balances', name: null });

  assert.equal(data.mode, 'advanced');
  assert.ok(Array.isArray(data.fields));
  assert.equal(data.fields.length, 4);

  const dateField = data.fields.find(function(f) { return f.key === 'assertion_date'; });
  assert.ok(dateField, 'assertion_date field present');
  assert.equal(dateField.type, 'date');
  assert.equal(dateField.required, true);
  assert.equal(dateField.default, null);

  const accountField = data.fields.find(function(f) { return f.key === 'account'; });
  assert.ok(accountField, 'account field present');
  assert.equal(accountField.type, 'account-search');
  assert.equal(accountField['selection-options'].length, 2);

  const amountField = data.fields.find(function(f) { return f.key === 'amount'; });
  assert.ok(amountField, 'amount field present');
  assert.equal(amountField.type, 'number');

  const symbolField = data.fields.find(function(f) { return f.key === 'symbol'; });
  assert.ok(symbolField, 'symbol field present');
  assert.equal(symbolField.type, 'select');
  assert.equal(symbolField['selection-options'].length, 2);
});

test('getSidebarData (edit mode) fetches entity from API and populates defaults', () => {
  const { sandbox } = loadCode();
  const apiCalls = [];
  sandbox.apiFetchJson_ = function(method, path) {
    apiCalls.push({ method, path });
    return makeBalanceApi();
  };
  sandbox.loadAccountOptions_ = function() {
    return [{ resource_name: 'accounts/checking', display_name: '[A] Checking' }];
  };
  sandbox.listCommodityOptions_ = function() { return [{ symbol: 'CHF' }]; };

  const data = sandbox.getSidebarData({ classKey: 'balances', name: 'balanceAssertions/bal_1' });

  assert.equal(data.mode, 'advanced');
  assert.ok(apiCalls.some(function(c) { return c.path === '/balance-assertions/bal_1'; }));

  const dateField = data.fields.find(function(f) { return f.key === 'assertion_date'; });
  assert.equal(dateField.default, '2026-04-19');

  const accountField = data.fields.find(function(f) { return f.key === 'account'; });
  assert.equal(accountField.default, 'accounts/checking');

  const amountField = data.fields.find(function(f) { return f.key === 'amount'; });
  assert.equal(amountField.default, '1000.00');

  const symbolField = data.fields.find(function(f) { return f.key === 'symbol'; });
  assert.equal(symbolField.default, 'CHF');
});

// --- submitEntity ---

test('submitEntity (create) POSTs correct payload and inserts row at sorted position', () => {
  const rowStore = new Map([
    [2, { resource_name: 'balanceAssertions/bal_0', assertion_date: '2026-04-10', account: '[A] Checking', amount: 500, symbol: 'CHF', edit: false, issues: '' }],
    [3, { resource_name: 'balanceAssertions/bal_2', assertion_date: '2026-04-25', account: '[A] Checking', amount: 2000, symbol: 'CHF', edit: false, issues: '' }],
  ]);
  const apiCalls = [];
  const { sandbox } = loadCode({
    SpreadsheetApp: {
      getActiveSpreadsheet() { return { toast() {}, getSheetByName() { return null; }, setActiveSheet() {} }; },
    },
  });
  const fakeSheet = makeBalanceSheet_(sandbox, rowStore, []);
  sandbox.apiFetchJson_ = function(method, path, payload) {
    apiCalls.push({ method, path, payload });
    if (method === 'post') {
      return makeBalanceApi();
    }
    return {};
  };
  sandbox.getOrCreateSheet_ = function() { return fakeSheet; };
  sandbox.loadAccountOptions_ = function() {
    return [{ resource_name: 'accounts/checking', display_name: '[A] Checking' }];
  };
  sandbox.refreshDoctorIssueSheets_ = function() {};

  const result = sandbox.submitEntity({ classKey: 'balances', name: null, span: null }, {
    assertion_date: '2026-04-19',
    account: 'accounts/checking',
    amount: '1000.00',
    symbol: 'CHF',
  });

  const postCall = apiCalls.find(function(c) { return c.method === 'post'; });
  assert.ok(postCall, 'expected POST call');
  assert.equal(postCall.path, '/balance-assertions');
  assert.equal(postCall.payload.balance_assertion.assertion_date, '2026-04-19');
  assert.equal(postCall.payload.balance_assertion.account, 'accounts/checking');
  assert.equal(postCall.payload.balance_assertion.amount.amount, '1000.00');
  assert.equal(postCall.payload.balance_assertion.amount.symbol, 'CHF');

  assert.equal(rowStore.get(2).resource_name, 'balanceAssertions/bal_0');
  assert.equal(rowStore.get(3).resource_name, 'balanceAssertions/bal_1');
  assert.equal(rowStore.get(4).resource_name, 'balanceAssertions/bal_2');
  assert.ok(result.span);
});

test('submitEntity (edit) PATCHes correct payload and updates row in place', () => {
  const rowStore = new Map([
    [2, { resource_name: 'balanceAssertions/bal_1', assertion_date: '2026-04-19', account: '[A] Checking', amount: 1000, symbol: 'CHF', edit: false, issues: '' }],
  ]);
  const apiCalls = [];
  const { sandbox } = loadCode({
    SpreadsheetApp: {
      getActiveSpreadsheet() { return { toast() {}, getSheetByName() { return null; } }; },
    },
  });
  const fakeSheet = makeBalanceSheet_(sandbox, rowStore, []);
  sandbox.apiFetchJson_ = function(method, path, payload) {
    apiCalls.push({ method, path, payload });
    if (method === 'patch') {
      return makeBalanceApi({ amount: { amount: '1500.00', symbol: 'CHF' } });
    }
    return {};
  };
  sandbox.getOrCreateSheet_ = function() { return fakeSheet; };
  sandbox.loadAccountOptions_ = function() {
    return [{ resource_name: 'accounts/checking', display_name: '[A] Checking' }];
  };
  sandbox.refreshDoctorIssueSheets_ = function() {};

  sandbox.submitEntity({ classKey: 'balances', name: 'balanceAssertions/bal_1', span: { start: 2, count: 1 } }, {
    assertion_date: '2026-04-19',
    account: 'accounts/checking',
    amount: '1500.00',
    symbol: 'CHF',
  });

  const patchCall = apiCalls.find(function(c) { return c.method === 'patch'; });
  assert.ok(patchCall, 'expected PATCH call');
  assert.equal(patchCall.path, '/balance-assertions/bal_1');
  assert.equal(patchCall.payload.update_mask, 'assertion_date,account,amount');
  assert.equal(patchCall.payload.balance_assertion.amount.amount, '1500.00');

  assert.equal(rowStore.size, 1);
  assert.equal(rowStore.get(2).amount, '1500.00');
});

test('submitEntity (edit) returns null on API failure', () => {
  const alerts = [];
  const rowStore = new Map([
    [2, { resource_name: 'balanceAssertions/bal_1', assertion_date: '2026-04-19', account: '[A] Checking', amount: 1000, symbol: 'CHF', edit: false, issues: '' }],
  ]);
  const { sandbox } = loadCode({
    SpreadsheetApp: {
      getActiveSpreadsheet() { return { toast() {} }; },
      getUi() { return { alert(title, msg, _btn) { alerts.push({ title, msg }); }, ButtonSet: { OK: 0 } }; },
    },
  });
  const fakeSheet = makeBalanceSheet_(sandbox, rowStore, []);
  sandbox.getOrCreateSheet_ = function() { return fakeSheet; };
  sandbox.loadAccountOptions_ = function() { return []; };
  sandbox.apiFetchJson_ = function() { throw new Error('api_error: something went wrong'); };

  const result = sandbox.submitEntity(
    { classKey: 'balances', name: 'balanceAssertions/bal_1', span: { start: 2, count: 1 } },
    { assertion_date: '2026-04-19', account: 'accounts/checking', amount: '1000', symbol: 'CHF' },
  );

  assert.equal(result, null);
  assert.ok(alerts.length > 0, 'expected alert on error');
});

// --- deleteEntity ---

test('deleteEntity calls DELETE and removes row from sheet', () => {
  const rowStore = new Map([
    [2, { resource_name: 'balanceAssertions/bal_1', assertion_date: '2026-04-19', account: '[A] Checking', amount: 1000, symbol: 'CHF', edit: false, issues: '' }],
    [3, { resource_name: 'balanceAssertions/bal_2', assertion_date: '2026-04-25', account: '[A] Checking', amount: 2000, symbol: 'CHF', edit: false, issues: '' }],
  ]);
  const apiCalls = [];
  const { sandbox } = loadCode({
    SpreadsheetApp: {
      getActiveSpreadsheet() { return { toast() {}, getSheetByName() { return null; } }; },
    },
  });
  const fakeSheet = makeBalanceSheet_(sandbox, rowStore, []);
  sandbox.apiFetchJson_ = function(method, path) {
    apiCalls.push({ method, path });
    return {};
  };
  sandbox.getOrCreateSheet_ = function() { return fakeSheet; };
  sandbox.loadAccountOptions_ = function() { return []; };
  sandbox.refreshDoctorIssueSheets_ = function() {};

  sandbox.deleteEntity({ classKey: 'balances', name: 'balanceAssertions/bal_1', span: { start: 2, count: 1 } });

  const deleteCall = apiCalls.find(function(c) { return c.method === 'delete'; });
  assert.ok(deleteCall, 'expected DELETE call');
  assert.equal(deleteCall.path, '/balance-assertions/bal_1');

  assert.equal(rowStore.size, 1);
  assert.equal(rowStore.get(2).resource_name, 'balanceAssertions/bal_2');
});

// --- handleEntitySheetEdit_ ---

test('handleEntitySheetEdit_ ignores non-editable column on balances sheet', () => {
  const { sandbox } = loadCode();
  const rowStore = new Map([
    [2, { resource_name: 'balanceAssertions/bal_1', assertion_date: '2026-04-19', account: '[A] Checking', amount: 1000, symbol: 'CHF', edit: false, issues: '' }],
  ]);
  const fakeSheet = makeBalanceSheet_(sandbox, rowStore, []);
  fakeSheet.getName = function() { return 'Balances'; };
  sandbox.loadAccountOptions_ = function() { return []; };

  const assertionDateColumn = sandbox.getSheetConfigByName_('Balances').columns.assertion_date.column;
  const event = { range: { getSheet() { return fakeSheet; }, getRow() { return 2; }, getColumn() { return assertionDateColumn; }, getValue() { return '2026-05-01'; } }, value: '2026-05-01', oldValue: '2026-04-19' };

  assert.doesNotThrow(function() {
    sandbox.handleEntitySheetEdit_(event);
  });
});

test('handleEntitySheetEdit_ on edit column opens sidebar for balance assertion', () => {
  const sidebarCalls = [];
  const { sandbox } = loadCode();
  const rowStore = new Map([
    [2, { resource_name: 'balanceAssertions/bal_1', assertion_date: '2026-04-19', account: '[A] Checking', amount: 1000, symbol: 'CHF', edit: false, issues: '' }],
  ]);
  const fakeSheet = makeBalanceSheet_(sandbox, rowStore, []);
  fakeSheet.getName = function() { return 'Balances'; };
  sandbox.loadAccountOptions_ = function() { return [{ resource_name: 'accounts/checking', display_name: '[A] Checking' }]; };
  sandbox.showEditSidebar_ = function(classKey, name, span, context) {
    sidebarCalls.push({ classKey, name, span, context });
  };

  const editColumn = sandbox.getSheetConfigByName_('Balances').columns.edit.column;
  const event = { range: { getSheet() { return fakeSheet; }, getRow() { return 2; }, getColumn() { return editColumn; }, getValue() { return true; } }, value: 'TRUE', oldValue: '' };

  sandbox.handleEntitySheetEdit_(event);

  assert.equal(sidebarCalls.length, 1);
  assert.equal(sidebarCalls[0].classKey, 'balances');
  assert.equal(sidebarCalls[0].name, 'balanceAssertions/bal_1');
});
