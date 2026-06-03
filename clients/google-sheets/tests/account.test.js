const test = require('node:test');
const assert = require('node:assert/strict');

const { loadCode, makeRowStoreSheet_ } = require('./_harness');

function makeAccountApi(overrides) {
  return Object.assign({
    name: 'accounts/zkb',
    account_name: 'Assets:Family:ZKB:Checking',
  }, overrides);
}

function getAccount(sandbox) {
  return sandbox.ENTITY_REGISTRY['Accounts'];
}

function makeAccountSheet_(sandbox, rowStore, operations) {
  return makeRowStoreSheet_(sandbox, rowStore, operations, 'Accounts');
}

// --- Account.fromApi / toApiPayload_ / validate ---

test('Account.fromApi produces correct _api shape', () => {
  const { sandbox } = loadCode();
  const a = getAccount(sandbox).fromApi_(makeAccountApi());

  assert.equal(a.getName(), 'accounts/zkb');
  assert.equal(a._api.account_name, 'Assets:Family:ZKB:Checking');
});

test('Account.toApiPayload_ includes only account_name', () => {
  const { sandbox } = loadCode();
  const a = getAccount(sandbox).fromApi_(makeAccountApi());
  const payload = a.toApiPayload_();

  assert.ok(!('name' in payload));
  assert.ok(!('edit' in payload));
  assert.ok(!('issues' in payload));
  assert.equal(payload.account_name, 'Assets:Family:ZKB:Checking');
});

test('Account.validate throws when account_name is missing', () => {
  const { sandbox } = loadCode();
  const a = getAccount(sandbox).fromApi_(makeAccountApi({ account_name: null }));
  assert.throws(function() { a.validate(); }, /account name/i);
});

test('Account.validate throws when account_name is empty string', () => {
  const { sandbox } = loadCode();
  const a = getAccount(sandbox).fromApi_(makeAccountApi({ account_name: '' }));
  assert.throws(function() { a.validate(); }, /account name/i);
});

// --- Account.toRows_ ---

test('Account.toRows_ stores display name from formatAccountDisplayName_', () => {
  const { sandbox } = loadCode();
  const a = getAccount(sandbox).fromApi_(makeAccountApi());
  const rows = a.toRows_();

  assert.equal(rows.length, 1);
  assert.equal(rows[0].resource_name, 'accounts/zkb');
  assert.equal(rows[0].edit, false);
  assert.equal(rows[0].issues, '');
  // formatAccountDisplayName_('Assets:Family:ZKB:Checking') → '[A] Family - ZKB - Checking'
  assert.ok(rows[0].account_name.startsWith('[A]'), 'account_name should be display-formatted');
});

// --- Account.fromRows ---

test('Account.fromRows sets _api.name from resource_name and _api.account_name is null', () => {
  const { sandbox } = loadCode();
  const rows = [{ edit: false, resource_name: 'accounts/zkb', account_name: '[A] Family - ZKB - Checking', issues: '' }];
  const a = getAccount(sandbox).fromRows(rows, {}, { start: 2, count: 1 });

  assert.equal(a._api.name, 'accounts/zkb');
  assert.equal(a._api.account_name, null);
  assert.deepEqual(a._span, { start: 2, count: 1 });
});

// --- Account.buildSidebarFields_ ---

test('Account.buildSidebarFields_ returns mode:advanced and empty default for add mode', () => {
  const { sandbox } = loadCode();
  const result = getAccount(sandbox).buildSidebarFields_(null, 'simple');

  assert.equal(result.mode, 'advanced');
  assert.equal(result.fields.length, 3);
  assert.equal(result.fields[0].key, 'account_name');
  assert.equal(result.fields[0].type, 'text');
  assert.equal(result.fields[0].default, null);
  assert.equal(result.fields[1].key, 'effective_start_date');
  assert.equal(result.fields[1].type, 'date');
  assert.equal(result.fields[2].key, 'effective_end_date');
  assert.equal(result.fields[2].type, 'date');
});

test('Account.buildSidebarFields_ fetches canonical name from API for edit mode', () => {
  const { sandbox } = loadCode();
  sandbox.apiFetchJson_ = function(method, path) {
    if (method === 'get' && path === '/accounts/zkb') {
      return { name: 'accounts/zkb', account_name: 'Assets:Family:ZKB:Checking' };
    }
    throw new Error('unexpected: ' + method + ' ' + path);
  };

  const result = getAccount(sandbox).buildSidebarFields_('accounts/zkb', 'advanced');

  assert.equal(result.mode, 'advanced');
  assert.equal(result.fields[0].default, 'Assets:Family:ZKB:Checking');
});

// --- scanEntityRows_ / findEntityRowsFromAnchor_ ---

test('findEntityRowsFromAnchor_ finds single-row account from anchor', () => {
  const { sandbox } = loadCode();
  const rowStore = new Map([
    [2, { edit: false, resource_name: 'accounts/zkb', account_name: '[A] Family - ZKB - Checking', issues: '' }],
  ]);
  const sheet = makeAccountSheet_(sandbox, rowStore, []);

  const entity = sandbox.findEntityRowsFromAnchor_(getAccount(sandbox), sheet, 2);

  assert.equal(entity.getName(), 'accounts/zkb');
  assert.deepEqual(JSON.parse(JSON.stringify(entity._span)), { start: 2, count: 1 });
});

test('findEntityRowsFromAnchor_ throws when anchor row has no resource_name', () => {
  const { sandbox } = loadCode();
  const rowStore = new Map([
    [2, { edit: false, resource_name: '', account_name: '', issues: '' }],
  ]);
  const sheet = makeAccountSheet_(sandbox, rowStore, []);

  assert.throws(function() {
    sandbox.findEntityRowsFromAnchor_(getAccount(sandbox), sheet, 2);
  }, /account/i);
});

// --- submitEntity (add + edit) ---

test('submitEntity creates new account via POST and writes display name to sheet', () => {
  const operations = [];
  const rowStore = new Map();
  const { sandbox } = loadCode({
    SpreadsheetApp: {
      getActiveSpreadsheet() { return { toast() {}, getSheetByName() { return null; }, setActiveSheet() {} }; },
    },
  });
  const sheet = makeAccountSheet_(sandbox, rowStore, operations);

  sandbox.apiFetchJson_ = function(method, path, body) {
    if (method === 'post' && path === '/accounts') {
      return { name: 'accounts/zkb-new', account_name: body.account.account_name };
    }
    throw new Error('unexpected: ' + method + ' ' + path);
  };
  sandbox.getOrCreateSheet_ = function() { return sheet; };
  sandbox.refreshDoctorIssueSheets_ = function() {};

  sandbox.submitEntity(
    { classKey: 'accounts', name: null, span: null, context: null },
    { account_name: 'Assets:Family:ZKB:New' }
  );

  const written = rowStore.get(2);
  assert.ok(written, 'row should be written to sheet');
  assert.equal(written.resource_name, 'accounts/zkb-new');
  assert.ok(written.account_name.startsWith('[A]'), 'should store display name');
});

test('submitEntity edits existing account via PATCH', () => {
  const operations = [];
  const rowStore = new Map([
    [2, { edit: false, resource_name: 'accounts/zkb', account_name: '[A] Family - ZKB - Checking', issues: '' }],
  ]);
  const { sandbox } = loadCode({
    SpreadsheetApp: {
      getActiveSpreadsheet() { return { toast() {}, getSheetByName() { return null; } }; },
    },
  });
  const sheet = makeAccountSheet_(sandbox, rowStore, operations);
  let patchBody = null;

  sandbox.apiFetchJson_ = function(method, path, body) {
    if (method === 'patch' && path === '/accounts/zkb') {
      patchBody = body;
      return { name: 'accounts/zkb', account_name: body.account.account_name };
    }
    throw new Error('unexpected: ' + method + ' ' + path);
  };
  sandbox.getOrCreateSheet_ = function() { return sheet; };
  sandbox.refreshDoctorIssueSheets_ = function() {};

  sandbox.submitEntity(
    { classKey: 'accounts', name: 'accounts/zkb', span: { start: 2, count: 1 }, context: null },
    { account_name: 'Assets:Family:ZKB:Savings' }
  );

  assert.equal(patchBody.account.account_name, 'Assets:Family:ZKB:Savings');
  assert.equal(patchBody.update_mask, 'account_name,effective_start_date,effective_end_date');
  const updated = rowStore.get(2);
  assert.ok(updated.account_name.startsWith('[A]'), 'should store display name after edit');
});
