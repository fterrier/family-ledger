const test = require('node:test');
const assert = require('node:assert/strict');

const { loadCode, makeRowStoreSheet_ } = require('./_harness');

function getTransaction(sandbox) {
  return sandbox.ENTITY_REGISTRY['Transactions'];
}

// Build a Transaction for applyEdit unit tests without touching the sheet.
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
    postings: [
      { account: 'accounts/checking', units: { amount: '-84.25', symbol: 'CHF' } },
      { account: 'accounts/food', units: { amount: '50', symbol: 'CHF' }, narration: null },
      { account: 'accounts/household', units: { amount: '34.25', symbol: 'CHF' }, narration: null },
    ],
  };
}

// --- payee ---

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

// --- narration ---

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
  tx.applyEdit('narration', 'Household', 'Groceries', 3); // row 3 = offset 1
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

test("Transaction.applyEdit('narration') throws when converting last null posting to custom narration", () => {
  const { sandbox } = loadCode();
  const api = splitApi();
  api.postings[2].narration = 'Household goods'; // postings[1] is the only null
  const tx = makeTx(sandbox, api, { start: 2, count: 2 });
  assert.throws(
    () => tx.applyEdit('narration', 'Produce', 'Groceries', 2),
    /At least one split row must keep the transaction narration/
  );
  assert.equal(tx._api.postings[1].narration, null);
});

test("Transaction.applyEdit('narration') does not throw when other posting already has null", () => {
  const { sandbox } = loadCode();
  const api = splitApi(); // both postings[1] and [2] have narration: null
  const tx = makeTx(sandbox, api, { start: 2, count: 2 });
  tx.applyEdit('narration', 'Produce', 'Groceries', 2);
  assert.equal(tx._api.postings[1].narration, 'Produce');
  assert.equal(tx._api.postings[2].narration, null);
});

// --- destination_account_name ---

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

// --- amount ---

test("Transaction.applyEdit('amount') inserts split posting with leftover amount", () => {
  const { sandbox } = loadCode();
  const tx = makeTx(sandbox, singleDestApi());
  tx.applyEdit('amount', '50', '84.25', 2);
  assert.equal(tx._api.postings.length, 3);
  assert.equal(tx._api.postings[1].units.amount, '50');
  assert.equal(tx._api.postings[2].units.amount, '34.25');
  assert.equal(tx._api.postings[0].units.amount, '-84.25');
});

test("Transaction.applyEdit('amount') no-op when amounts are equal", () => {
  const { sandbox } = loadCode();
  const tx = makeTx(sandbox, singleDestApi());
  tx.applyEdit('amount', '84.25', '84.25', 2);
  assert.equal(tx._api.postings.length, 2);
});

test("Transaction.applyEdit('amount') treats numeric 0 as valid new amount", () => {
  const { sandbox } = loadCode();
  const tx = makeTx(sandbox, singleDestApi());
  tx.applyEdit('amount', 0, '84.25', 2);
  assert.equal(tx._api.postings.length, 3);
  assert.equal(tx._api.postings[1].units.amount, '0');
  assert.equal(tx._api.postings[2].units.amount, '84.25');
});

test("Transaction.applyEdit('amount') throws for source-only transaction", () => {
  const { sandbox } = loadCode();
  const tx = makeTx(sandbox, {
    name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: '', narration: 'Interest',
    postings: [{ account: 'accounts/checking', units: { amount: '1.5', symbol: 'CHF' } }],
  });
  assert.throws(
    () => tx.applyEdit('amount', '1', '1.5', 2),
    /Amount cannot be edited until a destination account is set/
  );
});

test("Transaction.applyEdit('amount') throws for invalid (NaN) new amount", () => {
  const { sandbox } = loadCode();
  const tx = makeTx(sandbox, singleDestApi());
  assert.throws(
    () => tx.applyEdit('amount', 'bad', '84.25', 2),
    /Invalid amount/
  );
});

test("Transaction.applyEdit('amount') no-op when old amount is NaN (blank cell)", () => {
  const { sandbox } = loadCode();
  const tx = makeTx(sandbox, singleDestApi());
  tx.applyEdit('amount', '50', '', 2); // oldValue blank → NaN → no-op
  assert.equal(tx._api.postings.length, 2); // no split
});

// --- split_off_amount ---

test("Transaction.applyEdit('split_off_amount') numeric creates split posting", () => {
  const { sandbox } = loadCode();
  const tx = makeTx(sandbox, singleDestApi());
  tx.applyEdit('split_off_amount', '34.25', '', 2);
  assert.equal(tx._api.postings.length, 3);
  assert.equal(tx._api.postings[1].units.amount, '50');
  assert.equal(tx._api.postings[2].units.amount, '34.25');
  assert.equal(tx._api.postings[2].narration, null);
});

test("Transaction.applyEdit('split_off_amount') 0 is a valid split amount", () => {
  const { sandbox } = loadCode();
  const tx = makeTx(sandbox, singleDestApi());
  tx.applyEdit('split_off_amount', 0, '', 2);
  assert.equal(tx._api.postings.length, 3);
  assert.equal(tx._api.postings[1].units.amount, '84.25');
  assert.equal(tx._api.postings[2].units.amount, '0');
});

test("Transaction.applyEdit('split_off_amount') throws when split equals original", () => {
  const { sandbox } = loadCode();
  const tx = makeTx(sandbox, singleDestApi());
  assert.throws(
    () => tx.applyEdit('split_off_amount', '84.25', '', 2),
    /Split amount must differ from the row amount/
  );
});

test("Transaction.applyEdit('split_off_amount') numeric throws for source-only transaction", () => {
  const { sandbox } = loadCode();
  const tx = makeTx(sandbox, {
    name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: '', narration: 'Interest',
    postings: [{ account: 'accounts/checking', units: { amount: '1.5', symbol: 'CHF' } }],
  });
  assert.throws(
    () => tx.applyEdit('split_off_amount', '0.5', '', 2),
    /Split is unavailable until a destination account is set/
  );
});

test("Transaction.applyEdit('split_off_amount') empty instruction is a no-op", () => {
  const { sandbox } = loadCode();
  const tx = makeTx(sandbox, singleDestApi());
  tx.applyEdit('split_off_amount', '', '', 2);
  assert.equal(tx._api.postings.length, 2);
});

test("Transaction.applyEdit('split_off_amount') x on single destination makes source-only", () => {
  const { sandbox } = loadCode();
  const tx = makeTx(sandbox, singleDestApi());
  tx.applyEdit('split_off_amount', 'x', '', 2);
  assert.equal(tx._api.postings.length, 1);
});

test("Transaction.applyEdit('split_off_amount') x on lower of two rows merges into upper", () => {
  const { sandbox } = loadCode();
  const tx = makeTx(sandbox, splitApi(), { start: 2, count: 2 });
  tx.applyEdit('split_off_amount', 'x', '', 3); // delete row 3 (offset 1)
  assert.equal(tx._api.postings.length, 2);
  assert.equal(tx._api.postings[1].account, 'accounts/food');
  assert.equal(parseFloat(tx._api.postings[1].units.amount), 84.25);
});

test("Transaction.applyEdit('split_off_amount') x on upper of two rows merges into lower", () => {
  const { sandbox } = loadCode();
  const tx = makeTx(sandbox, splitApi(), { start: 2, count: 2 });
  tx.applyEdit('split_off_amount', 'x', '', 2); // delete row 2 (offset 0)
  assert.equal(tx._api.postings.length, 2);
  assert.equal(tx._api.postings[1].account, 'accounts/household');
  assert.equal(parseFloat(tx._api.postings[1].units.amount), 84.25);
});

test("Transaction.applyEdit('split_off_amount') x reduces to 1 and resets surviving posting narration to null", () => {
  const { sandbox } = loadCode();
  const api = splitApi();
  api.postings[2].narration = 'Household goods';
  const tx = makeTx(sandbox, api, { start: 2, count: 2 });
  tx.applyEdit('split_off_amount', 'x', '', 3);
  assert.equal(tx._api.postings.length, 2);
  assert.equal(tx._api.postings[1].narration, null);
});

test("Transaction.applyEdit('split_off_amount') - is treated as delete like x", () => {
  const { sandbox } = loadCode();
  const tx = makeTx(sandbox, splitApi(), { start: 2, count: 2 });
  tx.applyEdit('split_off_amount', '-', '', 3);
  assert.equal(tx._api.postings.length, 2);
});

// --- handleEntitySheetEdit_ ---

function makeHandleEditSandbox(toasts) {
  const { sandbox } = loadCode({
    SpreadsheetApp: {
      getActiveSpreadsheet() {
        return { toast(msg, title, sec) { toasts.push({ msg, title, sec }); } };
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
  const rowStore = new Map([[2, { resource_name: 'transactions/txn_1', amount: 99 }]]);
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, []);

  const col = sandbox.getSheetConfigByName_('Transactions').headers.indexOf('amount') + 1;
  sandbox.handleEntitySheetEdit_({
    range: {
      getSheet() { return fakeSheet; },
      getRow() { return 2; },
      getColumn() { return col; },
      getValue() { return 'notanumber'; },
    },
    value: 'notanumber',
    oldValue: 84.25,  // number, as GAS provides it
  });

  assert.equal(rowStore.get(2).amount, 84.25);  // restored to original numeric value
  assert.ok(toasts.some(t => /Invalid amount/.test(t.msg)));
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
  // must not throw
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
      getRow() { return 1; }, // header row
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
  // 'transaction_date' is not editable
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
