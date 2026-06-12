const test = require('node:test');
const assert = require('node:assert/strict');

const { loadCode, makeRowStoreSheet_ } = require('./_harness');

function makeCommodityApi(overrides) {
  return Object.assign({
    name: 'commodities/cmd_chf',
    symbol: 'CHF',
    entity_metadata: {},
  }, overrides);
}

function getCommodity(sandbox) {
  return sandbox.ENTITY_REGISTRY['Commodities'];
}

function makeCommoditySheet_(sandbox, rowStore, operations) {
  return makeRowStoreSheet_(sandbox, rowStore, operations, 'Commodities');
}

// --- Commodity.fromApi / toApiPayload_ / validate ---

test('Commodity.fromApi produces correct _api shape', () => {
  const { sandbox } = loadCode();
  const c = getCommodity(sandbox).fromApi_(makeCommodityApi());

  assert.equal(c.getName(), 'commodities/cmd_chf');
  assert.equal(c._api.symbol, 'CHF');
});

test('Commodity.toApiPayload_ includes only symbol', () => {
  const { sandbox } = loadCode();
  const c = getCommodity(sandbox).fromApi_(makeCommodityApi());
  const payload = c.toApiPayload_();

  assert.equal(payload.symbol, 'CHF');
  assert.ok(!('name' in payload));
  assert.ok(!('edit' in payload));
  assert.ok(!('entity_metadata' in payload));
});

test('Commodity.validate throws when symbol is missing', () => {
  const { sandbox } = loadCode();
  const c = getCommodity(sandbox).fromApi_(makeCommodityApi({ symbol: null }));
  assert.throws(function() { c.validate(); }, /symbol/i);
});

test('Commodity.validate throws when symbol is empty string', () => {
  const { sandbox } = loadCode();
  const c = getCommodity(sandbox).fromApi_(makeCommodityApi({ symbol: '' }));
  assert.throws(function() { c.validate(); }, /symbol/i);
});

// --- Commodity.toRows_ ---

test('Commodity.toRows_ writes resource_name, symbol and resets edit to false', () => {
  const { sandbox } = loadCode();
  const c = getCommodity(sandbox).fromApi_(makeCommodityApi());
  const rows = c.toRows_();

  assert.equal(rows.length, 1);
  assert.equal(rows[0].resource_name, 'commodities/cmd_chf');
  assert.equal(rows[0].symbol, 'CHF');
  assert.equal(rows[0].edit, false);
});

// --- Commodity.fromRows ---

test('Commodity.fromRows sets _api.name from resource_name and _api.symbol is null', () => {
  const { sandbox } = loadCode();
  const rows = [{ edit: false, resource_name: 'commodities/cmd_chf', symbol: 'CHF' }];
  const c = getCommodity(sandbox).fromRows(rows, {}, { start: 2, count: 1 });

  assert.equal(c._api.name, 'commodities/cmd_chf');
  assert.equal(c._api.symbol, null);
  assert.deepEqual(c._span, { start: 2, count: 1 });
});

// --- Commodity.buildSidebarFields_ ---

test('Commodity.buildSidebarFields_ returns mode:advanced and null default for add mode', () => {
  const { sandbox } = loadCode();
  const result = getCommodity(sandbox).buildSidebarFields_(null, 'simple');

  assert.equal(result.mode, 'advanced');
  assert.equal(result.fields.length, 2);
  assert.equal(result.fields[0].key, 'symbol');
  assert.equal(result.fields[0].type, 'text');
  assert.equal(result.fields[0].required, true);
  assert.equal(result.fields[0].default, null);
  assert.equal(result.fields[1].key, 'ticker');
  assert.equal(result.fields[1].required, false);
  assert.equal(result.fields[1].default, null);
});

test('Commodity.buildSidebarFields_ fetches symbol from API for edit mode', () => {
  const { sandbox } = loadCode();
  sandbox.apiFetchJson_ = function(method, path) {
    if (method === 'get' && path === '/commodities/cmd_chf') {
      return makeCommodityApi({ symbol: 'CHF' });
    }
    throw new Error('unexpected: ' + method + ' ' + path);
  };

  const result = getCommodity(sandbox).buildSidebarFields_('commodities/cmd_chf', 'advanced');

  assert.equal(result.mode, 'advanced');
  assert.equal(result.fields[0].default, 'CHF');
});

// --- submitEntity (add + edit) ---

test('submitEntity creates new commodity via POST and writes row to sheet', () => {
  const operations = [];
  const rowStore = new Map();
  const { sandbox } = loadCode({
    SpreadsheetApp: {
      getActiveSpreadsheet() { return { toast() {}, getSheetByName() { return null; }, setActiveSheet() {} }; },
    },
  });
  const sheet = makeCommoditySheet_(sandbox, rowStore, operations);

  sandbox.apiFetchJson_ = function(method, path, body) {
    if (method === 'post' && path === '/commodities') {
      return makeCommodityApi({ name: 'commodities/cmd_new', symbol: body.commodity.symbol });
    }
    throw new Error('unexpected: ' + method + ' ' + path);
  };
  sandbox.getOrCreateSheet_ = function() { return sheet; };
  sandbox.refreshDoctorIssueSheets_ = function() {};

  sandbox.submitEntity(
    { classKey: 'commodities', name: null, span: null, context: null },
    { symbol: 'USD' }
  );

  const written = rowStore.get(2);
  assert.ok(written, 'row should be written to sheet');
  assert.equal(written.resource_name, 'commodities/cmd_new');
  assert.equal(written.symbol, 'USD');
  assert.equal(written.edit, false);
});

test('submitEntity edits existing commodity via PATCH with symbol update_mask', () => {
  const operations = [];
  const rowStore = new Map([
    [2, { edit: false, resource_name: 'commodities/cmd_chf', symbol: 'CHF' }],
  ]);
  const { sandbox } = loadCode({
    SpreadsheetApp: {
      getActiveSpreadsheet() { return { toast() {}, getSheetByName() { return null; } }; },
    },
  });
  const sheet = makeCommoditySheet_(sandbox, rowStore, operations);
  let patchBody = null;

  sandbox.apiFetchJson_ = function(method, path, body) {
    if (method === 'patch' && path === '/commodities/cmd_chf') {
      patchBody = body;
      return makeCommodityApi({ symbol: body.commodity.symbol });
    }
    throw new Error('unexpected: ' + method + ' ' + path);
  };
  sandbox.getOrCreateSheet_ = function() { return sheet; };
  sandbox.refreshDoctorIssueSheets_ = function() {};

  sandbox.submitEntity(
    { classKey: 'commodities', name: 'commodities/cmd_chf', span: { start: 2, count: 1 }, context: null },
    { symbol: 'CHFX' }
  );

  assert.equal(patchBody.commodity.symbol, 'CHFX');
  assert.ok(!('entity_metadata' in patchBody.commodity), 'entity_metadata should not be sent');
  assert.equal(patchBody.update_mask, 'symbol,ticker');
  const updated = rowStore.get(2);
  assert.equal(updated.symbol, 'CHFX');
});
