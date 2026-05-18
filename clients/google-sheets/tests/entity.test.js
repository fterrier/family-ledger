const test = require('node:test');
const assert = require('node:assert/strict');

const { loadCode, makeRowStoreSheet_ } = require('./_harness');

function getTransaction(sandbox) {
  return sandbox.ENTITY_REGISTRY['Transactions'];
}

// --- beginSaveGeneration_ / isCurrentSaveGeneration_ ---

test('beginSaveGeneration_ returns incrementing string values', () => {
  const { sandbox, documentProperties } = loadCode();

  const first = sandbox.beginSaveGeneration_('transactions/txn_1');
  const second = sandbox.beginSaveGeneration_('transactions/txn_1');

  assert.equal(first, '1');
  assert.equal(second, '2');
  assert.equal(documentProperties.get('family_ledger_save_generation:transactions/txn_1'), '2');
});

test('isCurrentSaveGeneration_ returns false for stale and true for current', () => {
  const { sandbox } = loadCode();

  sandbox.beginSaveGeneration_('transactions/txn_1');
  sandbox.beginSaveGeneration_('transactions/txn_1');

  assert.equal(sandbox.isCurrentSaveGeneration_('transactions/txn_1', '1'), false);
  assert.equal(sandbox.isCurrentSaveGeneration_('transactions/txn_1', '2'), true);
});

test('beginSaveGeneration_ tracks different entity names independently', () => {
  const { sandbox } = loadCode();

  const a1 = sandbox.beginSaveGeneration_('transactions/txn_a');
  const b1 = sandbox.beginSaveGeneration_('transactions/txn_b');
  const a2 = sandbox.beginSaveGeneration_('transactions/txn_a');

  assert.equal(a1, '1');
  assert.equal(b1, '1');
  assert.equal(a2, '2');
  assert.equal(sandbox.isCurrentSaveGeneration_('transactions/txn_a', '2'), true);
  assert.equal(sandbox.isCurrentSaveGeneration_('transactions/txn_b', '1'), true);
});

// --- Entity.save() via Transaction ---

const SAMPLE_API = {
  name: 'transactions/txn_1',
  transaction_date: '2026-04-19',
  payee: 'Migros',
  narration: 'Groceries',
  postings: [
    { account: 'accounts/checking', units: { amount: '-84.25', symbol: 'CHF' } },
    { account: 'accounts/food', units: { amount: '84.25', symbol: 'CHF' } },
  ],
};
const SAMPLE_CONTEXT = {
  accountResourceToDisplayName: {
    'accounts/checking': '[A] Checking',
    'accounts/food': '[X] Food',
  },
  accountDisplayNameToResource: {
    '[A] Checking': 'accounts/checking',
    '[X] Food': 'accounts/food',
  },
};

function makeSaveEntitySandbox() {
  const { sandbox } = loadCode();
  const Transaction = getTransaction(sandbox);
  const rowStore = new Map();
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, []);
  Transaction.writeToSheet_ = function(_sheet, _existingSpan, rows) {
    return { start: 2, count: rows.length };
  };
  return { sandbox, Transaction, fakeSheet };
}

test('Entity.save() calls createViaApi_ when _span is null (POST path)', () => {
  const { sandbox, Transaction, fakeSheet } = makeSaveEntitySandbox();
  const calls = [];
  Transaction.createViaApi_ = function(payload) {
    calls.push({ type: 'create', payload });
    return SAMPLE_API;
  };
  Transaction.updateViaApi_ = function() {
    throw new Error('updateViaApi_ must not be called on POST');
  };

  const entity = Transaction.fromApi({ ...SAMPLE_API, name: null }, SAMPLE_CONTEXT);
  entity.save(fakeSheet);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, 'create');
});

test('Entity.save() calls updateViaApi_ when _span is set (PATCH path)', () => {
  const { sandbox, Transaction, fakeSheet } = makeSaveEntitySandbox();
  const calls = [];
  Transaction.createViaApi_ = function() {
    throw new Error('createViaApi_ must not be called on PATCH');
  };
  Transaction.updateViaApi_ = function(entityName, payload) {
    calls.push({ type: 'update', entityName, payload });
    return SAMPLE_API;
  };

  const entity = Transaction.fromApi(SAMPLE_API, SAMPLE_CONTEXT);
  entity._span = { start: 2, count: 1 };
  entity.save(fakeSheet);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, 'update');
  assert.equal(calls[0].entityName, 'transactions/txn_1');
});

test('Entity.save() passes correct payload to updateViaApi_', () => {
  const { sandbox, Transaction, fakeSheet } = makeSaveEntitySandbox();
  let capturedPayload = null;
  Transaction.updateViaApi_ = function(_name, payload) {
    capturedPayload = payload;
    return SAMPLE_API;
  };

  const entity = Transaction.fromApi(SAMPLE_API, SAMPLE_CONTEXT);
  entity._span = { start: 2, count: 1 };
  entity.save(fakeSheet);

  assert.equal(capturedPayload.transaction_date, '2026-04-19');
  assert.equal(capturedPayload.payee, 'Migros');
  assert.ok(Array.isArray(capturedPayload.postings));
});

test('Entity.save() returns span from writeToSheet_', () => {
  const { sandbox, Transaction, fakeSheet } = makeSaveEntitySandbox();
  Transaction.updateViaApi_ = function() { return SAMPLE_API; };
  Transaction.writeToSheet_ = function() { return { start: 5, count: 2 }; };

  const entity = Transaction.fromApi(SAMPLE_API, SAMPLE_CONTEXT);
  entity._span = { start: 2, count: 1 };
  const result = entity.save(fakeSheet);

  assert.deepEqual(JSON.parse(JSON.stringify(result)), { start: 5, count: 2 });
});

test('Entity.save() propagates API error', () => {
  const { sandbox, Transaction, fakeSheet } = makeSaveEntitySandbox();
  Transaction.updateViaApi_ = function() {
    throw new Error('server error');
  };

  const entity = Transaction.fromApi(SAMPLE_API, SAMPLE_CONTEXT);
  entity._span = { start: 2, count: 1 };

  assert.throws(() => entity.save(fakeSheet), /server error/);
});

test('Entity.save() throws when toRows_ returns null', () => {
  const { sandbox, Transaction, fakeSheet } = makeSaveEntitySandbox();
  Transaction.updateViaApi_ = function() { return SAMPLE_API; };
  sandbox.flattenTransactionForSheet_ = function() { return null; };

  const entity = Transaction.fromApi(SAMPLE_API, SAMPLE_CONTEXT);
  entity._span = { start: 2, count: 1 };

  assert.throws(() => entity.save(fakeSheet), /could not be rendered/);
});

test('Entity.save() throws when toRows_ returns empty array', () => {
  const { sandbox, Transaction, fakeSheet } = makeSaveEntitySandbox();
  Transaction.updateViaApi_ = function() { return SAMPLE_API; };
  sandbox.flattenTransactionForSheet_ = function() { return []; };

  const entity = Transaction.fromApi(SAMPLE_API, SAMPLE_CONTEXT);
  entity._span = { start: 2, count: 1 };

  assert.throws(() => entity.save(fakeSheet), /could not be rendered/);
});

test('Entity.save() clears RESET_ON_SAVE_FIELDS on rows before writeToSheet_', () => {
  const { sandbox, Transaction, fakeSheet } = makeSaveEntitySandbox();
  Transaction.updateViaApi_ = function() { return SAMPLE_API; };
  let capturedRows = null;
  Transaction.writeToSheet_ = function(_sheet, _existingSpan, rows) {
    capturedRows = rows;
    return { start: 2, count: rows.length };
  };

  const entity = Transaction.fromApi(SAMPLE_API, SAMPLE_CONTEXT);
  entity._span = { start: 2, count: 1 };
  entity.toRows_ = function() {
    return [{ resource_name: 'transactions/txn_1', split_off_amount: 'should_be_cleared' }];
  };
  entity.save(fakeSheet);

  assert.equal(capturedRows[0].split_off_amount, '');
});

test('Entity.save() returns null when stale generation detected after API call', () => {
  const { sandbox, Transaction, fakeSheet } = makeSaveEntitySandbox();
  let writeToSheetCalled = false;
  Transaction.writeToSheet_ = function() {
    writeToSheetCalled = true;
    return { start: 2, count: 1 };
  };
  Transaction.updateViaApi_ = function() {
    // Simulate concurrent save bumping the generation
    sandbox.beginSaveGeneration_('transactions/txn_1');
    return SAMPLE_API;
  };

  const entity = Transaction.fromApi(SAMPLE_API, SAMPLE_CONTEXT);
  entity._span = { start: 2, count: 1 };
  const result = entity.save(fakeSheet);

  assert.equal(result, null);
  assert.equal(writeToSheetCalled, false);
});

test('Entity.save() skips generation check when entity has no name', () => {
  const { sandbox, Transaction, fakeSheet } = makeSaveEntitySandbox();
  Transaction.createViaApi_ = function() { return SAMPLE_API; };

  const entity = Transaction.fromApi({ ...SAMPLE_API, name: null }, SAMPLE_CONTEXT);
  const result = entity.save(fakeSheet);

  assert.notEqual(result, null);
});

// --- scanEntityRows_ ---

test('scanEntityRows_ returns correct span and rows for a single-row entity', () => {
  const { sandbox } = loadCode();
  const Transaction = getTransaction(sandbox);
  const rowStore = new Map([
    [2, { resource_name: 'transactions/txn_a' }],
    [3, { resource_name: 'transactions/txn_b' }],
  ]);
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, []);

  const result = sandbox.scanEntityRows_(Transaction, fakeSheet, 2);

  assert.deepEqual(JSON.parse(JSON.stringify(result.span)), { start: 2, count: 1 });
  assert.equal(result.entityName, 'transactions/txn_a');
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].__rowNumber, 2);
});

test('scanEntityRows_ collects all rows for a multi-row entity', () => {
  const { sandbox } = loadCode();
  const Transaction = getTransaction(sandbox);
  const rowStore = new Map([
    [2, { resource_name: 'transactions/txn_1' }],
    [3, { resource_name: 'transactions/txn_1' }],
    [4, { resource_name: 'transactions/txn_2' }],
  ]);
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, []);

  const result = sandbox.scanEntityRows_(Transaction, fakeSheet, 3);

  assert.deepEqual(JSON.parse(JSON.stringify(result.span)), { start: 2, count: 2 });
  assert.equal(result.entityName, 'transactions/txn_1');
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].__rowNumber, 2);
  assert.equal(result.rows[1].__rowNumber, 3);
});

test('scanEntityRows_ throws when anchor row has no entity name', () => {
  const { sandbox } = loadCode();
  const Transaction = getTransaction(sandbox);
  const rowStore = new Map([
    [2, { resource_name: '' }],
  ]);
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, []);

  assert.throws(
    () => sandbox.scanEntityRows_(Transaction, fakeSheet, 2),
    /does not contain a transaction/
  );
});

// --- findEntityRowsFromAnchor_ ---

test('findEntityRowsFromAnchor_ returns entity with _span set and correct name', () => {
  const { sandbox } = loadCode();
  const Transaction = getTransaction(sandbox);
  const rowStore = new Map([
    [2, {
      resource_name: 'transactions/txn_1',
      transaction_date: '2026-04-19',
      payee: 'Migros',
      narration: 'Groceries',
      narration_source: 'txn',
      source_account_name: '[A] Checking',
      destination_account_name: '[X] Food',
      amount: 84.25,
      symbol: 'CHF',
    }],
    [3, { resource_name: 'transactions/txn_2' }],
  ]);
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, []);
  sandbox.loadAccountOptions_ = function() {
    return [
      { resource_name: 'accounts/checking', display_name: '[A] Checking' },
      { resource_name: 'accounts/food', display_name: '[X] Food' },
    ];
  };

  const entity = sandbox.findEntityRowsFromAnchor_(Transaction, fakeSheet, 2);

  assert.deepEqual(JSON.parse(JSON.stringify(entity._span)), { start: 2, count: 1 });
  assert.equal(entity.getName(), 'transactions/txn_1');
});
