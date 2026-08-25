const test = require('node:test');
const assert = require('node:assert/strict');

const { loadCode, sampleTransaction, makeRowStoreSheet_ } = require('./_harness');

function getTransaction(sandbox) {
  return sandbox.ENTITY_REGISTRY['Transactions'];
}

// --- normalizeEntityDate_ ---

test('normalizeEntityDate_ passes strings through unchanged', () => {
  const { sandbox } = loadCode();

  assert.equal(sandbox.normalizeEntityDate_('2026-05-22'), '2026-05-22');
  assert.equal(sandbox.normalizeEntityDate_(''), '');
  assert.equal(sandbox.normalizeEntityDate_(null), '');
});

test('normalizeEntityDate_ formats Date objects using spreadsheet timezone', () => {
  const { sandbox } = loadCode();

  // UTC midnight on 2026-05-22 — in a UTC spreadsheet this must return 2026-05-22, not the day before.
  const d = new Date('2026-05-22T00:00:00.000Z');
  assert.equal(sandbox.normalizeEntityDate_(d), '2026-05-22');
});

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
  sandbox.applyEntityUpdateToSheet_ = function(_sheet, _config, _span, rows) {
    return { start: 2, count: rows.length };
  };
  sandbox.batchInsertEntitiesIntoSheet_ = function(groups) {
    const totalRows = groups.reduce(function(n, g) { return n + g.rows.length; }, 0);
    return [{ start: 2, count: totalRows }];
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

  const entity = Transaction.fromApi_({ ...SAMPLE_API, name: null }, SAMPLE_CONTEXT);
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

  const entity = Transaction.fromApi_(SAMPLE_API, SAMPLE_CONTEXT);
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

  const entity = Transaction.fromApi_(SAMPLE_API, SAMPLE_CONTEXT);
  entity._span = { start: 2, count: 1 };
  entity.save(fakeSheet);

  assert.equal(capturedPayload.transaction_date, '2026-04-19');
  assert.equal(capturedPayload.payee, 'Migros');
  assert.ok(Array.isArray(capturedPayload.postings));
});

test('Entity.save() returns span from _commitToSheet_', () => {
  const { sandbox, Transaction, fakeSheet } = makeSaveEntitySandbox();
  Transaction.updateViaApi_ = function() { return SAMPLE_API; };
  sandbox.applyEntityUpdateToSheet_ = function() { return { start: 5, count: 2 }; };

  const entity = Transaction.fromApi_(SAMPLE_API, SAMPLE_CONTEXT);
  entity._span = { start: 2, count: 1 };
  const result = entity.save(fakeSheet);

  assert.deepEqual(JSON.parse(JSON.stringify(result)), { start: 5, count: 2 });
});

test('Entity.save() propagates API error', () => {
  const { sandbox, Transaction, fakeSheet } = makeSaveEntitySandbox();
  Transaction.updateViaApi_ = function() {
    throw new Error('server error');
  };

  const entity = Transaction.fromApi_(SAMPLE_API, SAMPLE_CONTEXT);
  entity._span = { start: 2, count: 1 };

  assert.throws(() => entity.save(fakeSheet), /server error/);
});

test('Entity.save() throws when toRows_ returns null', () => {
  const { sandbox, Transaction, fakeSheet } = makeSaveEntitySandbox();
  Transaction.updateViaApi_ = function() { return SAMPLE_API; };
  sandbox.flattenTransactionForSheet_ = function() { return null; };

  const entity = Transaction.fromApi_(SAMPLE_API, SAMPLE_CONTEXT);
  entity._span = { start: 2, count: 1 };

  assert.throws(() => entity.save(fakeSheet), /could not be rendered/);
});

test('Entity.save() throws when toRows_ returns empty array', () => {
  const { sandbox, Transaction, fakeSheet } = makeSaveEntitySandbox();
  Transaction.updateViaApi_ = function() { return SAMPLE_API; };
  sandbox.flattenTransactionForSheet_ = function() { return []; };

  const entity = Transaction.fromApi_(SAMPLE_API, SAMPLE_CONTEXT);
  entity._span = { start: 2, count: 1 };

  assert.throws(() => entity.save(fakeSheet), /could not be rendered/);
});

test('Entity.save() clears RESET_ON_SAVE_FIELDS on rows before _commitToSheet_', () => {
  const { sandbox, Transaction, fakeSheet } = makeSaveEntitySandbox();
  Transaction.updateViaApi_ = function() { return SAMPLE_API; };
  let capturedRows = null;
  sandbox.applyEntityUpdateToSheet_ = function(_sheet, _config, _span, rows) {
    capturedRows = rows;
    return { start: 2, count: rows.length };
  };

  const entity = Transaction.fromApi_(SAMPLE_API, SAMPLE_CONTEXT);
  entity._span = { start: 2, count: 1 };
  entity.toRows_ = function() {
    return [{ resource_name: 'transactions/txn_1', split_off_amount: 'should_be_cleared' }];
  };
  entity.save(fakeSheet);

  assert.equal(capturedRows[0].split_off_amount, '');
});

test('Entity.save() returns null when stale generation detected after API call', () => {
  const { sandbox, Transaction, fakeSheet } = makeSaveEntitySandbox();
  let commitCalled = false;
  sandbox.applyEntityUpdateToSheet_ = function() {
    commitCalled = true;
    return { start: 2, count: 1 };
  };
  Transaction.updateViaApi_ = function() {
    // Simulate concurrent save bumping the generation
    sandbox.beginSaveGeneration_('transactions/txn_1');
    return SAMPLE_API;
  };

  const entity = Transaction.fromApi_(SAMPLE_API, SAMPLE_CONTEXT);
  entity._span = { start: 2, count: 1 };
  const result = entity.save(fakeSheet);

  assert.equal(result, null);
  assert.equal(commitCalled, false);
});

test('Entity.save() skips generation check when entity has no name', () => {
  const { sandbox, Transaction, fakeSheet } = makeSaveEntitySandbox();
  Transaction.createViaApi_ = function() { return SAMPLE_API; };

  const entity = Transaction.fromApi_({ ...SAMPLE_API, name: null }, SAMPLE_CONTEXT);
  const result = entity.save(fakeSheet);

  assert.notEqual(result, null);
});

test('Entity.save() calls the pending server op instead of PATCH/POST when _pendingServerOp is set', () => {
  const { sandbox, Transaction, fakeSheet } = makeSaveEntitySandbox();
  Transaction.createViaApi_ = function() { throw new Error('createViaApi_ must not be called'); };
  Transaction.updateViaApi_ = function() { throw new Error('updateViaApi_ must not be called'); };
  const calls = [];
  sandbox.apiFetchJson_ = function(method, path, body) {
    calls.push({ method, path, body });
    return SAMPLE_API;
  };

  const entity = Transaction.fromApi_(SAMPLE_API, SAMPLE_CONTEXT);
  entity._span = { start: 2, count: 1 };
  entity._pendingServerOp = { verb: 'split', body: { posting_index: 1, split_off_amount: '10.00', update_time: 5 } };
  entity.save(fakeSheet);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'post');
  assert.equal(calls[0].path, '/transactions/txn_1:split');
  assert.deepEqual(calls[0].body, { posting_index: 1, split_off_amount: '10.00', update_time: 5 });
});

test('Entity.save() with _pendingServerOp still updates _api and commits to sheet', () => {
  const { sandbox, Transaction, fakeSheet } = makeSaveEntitySandbox();
  sandbox.apiFetchJson_ = function() {
    return { ...SAMPLE_API, payee: 'After split' };
  };

  const entity = Transaction.fromApi_(SAMPLE_API, SAMPLE_CONTEXT);
  entity._span = { start: 2, count: 1 };
  entity._pendingServerOp = { verb: 'unsplit', body: { posting_index: 1, update_time: 5 } };
  entity.save(fakeSheet);

  assert.equal(entity._api.payee, 'After split');
});

test('Entity.save() without _pendingServerOp still uses PATCH/POST as before', () => {
  const { sandbox, Transaction, fakeSheet } = makeSaveEntitySandbox();
  const calls = [];
  Transaction.updateViaApi_ = function(entityName, payload) {
    calls.push({ entityName, payload });
    return SAMPLE_API;
  };
  sandbox.apiFetchJson_ = function() { throw new Error('apiFetchJson_ must not be called directly'); };

  const entity = Transaction.fromApi_(SAMPLE_API, SAMPLE_CONTEXT);
  entity._span = { start: 2, count: 1 };
  entity.save(fakeSheet);

  assert.equal(calls.length, 1);
});

// --- Entity.loadFromApi() ---

test('Entity.loadFromApi() fetches via apiFetchJson_ and constructs entity via fromApi_', () => {
  const { sandbox, Transaction } = makeSaveEntitySandbox();
  const calls = [];
  sandbox.apiFetchJson_ = function(method, path) {
    calls.push({ method, path });
    return SAMPLE_API;
  };
  sandbox.loadAccountOptions_ = function() {
    return [
      { resource_name: 'accounts/checking', display_name: '[A] Checking' },
      { resource_name: 'accounts/food', display_name: '[X] Food' },
    ];
  };

  const entity = Transaction.loadFromApi('transactions/txn_1');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'get');
  assert.ok(calls[0].path.includes('transactions/txn_1'));
  assert.equal(entity.getName(), 'transactions/txn_1');
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

// --- findEntityInsertionRow_ ---

test('findEntityInsertionRow_ inserts before first greater date and after same-date block', () => {
  const rowStore = new Map([
    [2, { resource_name: 'transactions/txn_1', transaction_date: '2026-04-18' }],
    [3, { resource_name: 'transactions/txn_2', transaction_date: '2026-04-19' }],
    [4, { resource_name: 'transactions/txn_3', transaction_date: '2026-04-19' }],
    [5, { resource_name: 'transactions/txn_4', transaction_date: '2026-04-21' }],
  ]);
  const { sandbox } = loadCode();
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, []);
  const txConfig = sandbox.getSheetConfigByName_('Transactions');

  assert.equal(sandbox.findEntityInsertionRow_(fakeSheet, txConfig, '2026-04-17'), 2);
  assert.equal(sandbox.findEntityInsertionRow_(fakeSheet, txConfig, '2026-04-19'), 5);
  assert.equal(sandbox.findEntityInsertionRow_(fakeSheet, txConfig, '2026-04-20'), 5);
  assert.equal(sandbox.findEntityInsertionRow_(fakeSheet, txConfig, '2026-04-22'), 6);
});

// --- findEntityInsertionRowFast_ ---

function addDays_(isoDate, days) {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// entitySizes: array of row-counts, one per entity, e.g. [1, 3, 1] — 3 entities,
// the second spanning 3 contiguous rows. Dates increase by 1 day per entity
// (all rows of one entity share its date, matching real Transaction rows).
function buildMultiRowFixture_(entitySizes, startDate) {
  const rowStore = new Map();
  let row = 2;
  let date = startDate || '2026-01-01';
  const boundaries = [];
  entitySizes.forEach(function(size, idx) {
    const start = row;
    for (let k = 0; k < size; k += 1) {
      rowStore.set(row, { resource_name: 'transactions/txn_' + idx, transaction_date: date });
      row += 1;
    }
    boundaries.push({ start: start, count: size, date: date });
    date = addDays_(date, 1);
  });
  return { rowStore: rowStore, boundaries: boundaries, lastRow: row - 1 };
}

function assertFastMatchesSlowForDates_(sandbox, fakeSheet, txConfig, dates) {
  dates.forEach(function(date) {
    const expected = sandbox.findEntityInsertionRow_(fakeSheet, txConfig, date);
    const actual = sandbox.findEntityInsertionRowFast_(fakeSheet, txConfig, date);
    assert.equal(actual, expected, 'mismatch for date ' + date + ': fast=' + actual + ' slow=' + expected);
  });
}

test('findEntityInsertionRowFast_ matches findEntityInsertionRow_ on the same before-all/same-date-block/after-all fixture', () => {
  const rowStore = new Map([
    [2, { resource_name: 'transactions/txn_1', transaction_date: '2026-04-18' }],
    [3, { resource_name: 'transactions/txn_2', transaction_date: '2026-04-19' }],
    [4, { resource_name: 'transactions/txn_3', transaction_date: '2026-04-19' }],
    [5, { resource_name: 'transactions/txn_4', transaction_date: '2026-04-21' }],
  ]);
  const { sandbox } = loadCode();
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, []);
  const txConfig = sandbox.getSheetConfigByName_('Transactions');

  assertFastMatchesSlowForDates_(sandbox, fakeSheet, txConfig,
    ['2026-04-17', '2026-04-18', '2026-04-19', '2026-04-20', '2026-04-21', '2026-04-22']);
});

test('findEntityInsertionRowFast_ returns 2 on an empty sheet', () => {
  const { sandbox } = loadCode();
  const fakeSheet = makeRowStoreSheet_(sandbox, new Map(), []);
  const txConfig = sandbox.getSheetConfigByName_('Transactions');

  assert.equal(sandbox.findEntityInsertionRowFast_(fakeSheet, txConfig, '2026-04-19'), 2);
});

test('findEntityInsertionRowFast_ matches findEntityInsertionRow_ across many multi-row entities of varying sizes', () => {
  const { rowStore, boundaries, lastRow } = buildMultiRowFixture_([1, 3, 1, 5, 2, 1, 4, 1, 1, 6, 2, 1]);
  const { sandbox } = loadCode();
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, []);
  const txConfig = sandbox.getSheetConfigByName_('Transactions');

  const probeDates = [addDays_(boundaries[0].date, -1)];
  boundaries.forEach(function(b) {
    probeDates.push(b.date);
    probeDates.push(addDays_(b.date, 1));
  });
  assertFastMatchesSlowForDates_(sandbox, fakeSheet, txConfig, probeDates);
  assert.ok(lastRow > 20, 'fixture should span enough rows to exercise the binary search');
});

test('findEntityInsertionRowFast_ correctly locates the boundary when an entity is larger than the initial scan window', () => {
  // 60-row entity — bigger than the ±25-row default window, forcing window expansion.
  const { rowStore, boundaries } = buildMultiRowFixture_([1, 1, 60, 1, 1]);
  const { sandbox } = loadCode();
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, []);
  const txConfig = sandbox.getSheetConfigByName_('Transactions');
  const bigEntity = boundaries[2];

  assertFastMatchesSlowForDates_(sandbox, fakeSheet, txConfig, [
    addDays_(bigEntity.date, -1), bigEntity.date, addDays_(bigEntity.date, 1),
  ]);
});

test('findEntityInsertionRowFast_ throws rather than risk a wrong answer when a row has a blank date', () => {
  const rowStore = new Map([
    [2, { resource_name: 'transactions/txn_1', transaction_date: '2026-04-18' }],
    [3, { resource_name: '', transaction_date: '' }],
    [4, { resource_name: 'transactions/txn_2', transaction_date: '2026-04-19' }],
    [5, { resource_name: 'transactions/txn_3', transaction_date: '2026-04-21' }],
  ]);
  const { sandbox } = loadCode();
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, []);
  const txConfig = sandbox.getSheetConfigByName_('Transactions');

  // The binary search may or may not probe row 3 depending on the target date —
  // assert the throw specifically for a target guaranteed to probe it.
  assert.throws(function() {
    sandbox.findEntityInsertionRowFast_(fakeSheet, txConfig, '2026-04-17');
  }, /blank date/);
});

test('findEntityInsertionRowFast_ issues O(log n) reads, not one O(n) full-sheet read, on a large sheet', () => {
  const { rowStore, boundaries } = buildMultiRowFixture_(new Array(300).fill(1));
  const { sandbox } = loadCode();
  const operations = [];
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, operations);
  const txConfig = sandbox.getSheetConfigByName_('Transactions');

  sandbox.findEntityInsertionRowFast_(fakeSheet, txConfig, boundaries[150].date);

  const reads = operations.filter(function(op) { return op.type === 'getValue' || op.type === 'getValues'; });
  // 300 rows: a full anchor read would be one getValues() covering all 300 rows.
  // The fast path should stay well under that via small probes + one bounded window read.
  assert.ok(reads.length < 40, 'expected O(log n) reads, got ' + reads.length);
  const fullRowReads = operations.filter(function(op) {
    return op.type === 'getValues' && op.numRows >= 300;
  });
  assert.equal(fullRowReads.length, 0, 'must not fall back to a full-sheet read for a well-formed sheet');
});

function makeGroupsForDates_(dates) {
  return dates.map(function(date, idx) {
    return {
      rows: [{ resource_name: 'transactions/txn_batch_' + idx, transaction_date: date }],
      entityDate: date,
    };
  });
}

test('findInsertionRowsForGroups_ uses per-group binary search at or below the threshold, one full read above it', () => {
  const { rowStore: smallRowStore } = buildMultiRowFixture_(new Array(50).fill(1));
  const { sandbox: sandboxSmall } = loadCode();
  const smallOps = [];
  const smallSheet = makeRowStoreSheet_(sandboxSmall, smallRowStore, smallOps);
  const txConfigSmall = sandboxSmall.getSheetConfigByName_('Transactions');
  const threshold = sandboxSmall.ANCHOR_BATCH_FAST_THRESHOLD_;

  const atThresholdGroups = makeGroupsForDates_(
    new Array(threshold).fill(0).map(function(_, i) { return addDays_('2026-01-01', i * 2 + 1); })
  );
  sandboxSmall.findInsertionRowsForGroups_(smallSheet, txConfigSmall, atThresholdGroups);
  const smallFullReads = smallOps.filter(function(op) { return op.type === 'getValues' && op.numRows >= 50; });
  assert.equal(smallFullReads.length, 0, 'at or below the threshold, must not pay for one full anchor read');
  const smallProbes = smallOps.filter(function(op) { return op.type === 'getValue'; });
  assert.ok(smallProbes.length > 0, 'expected per-group binary-search probes below the threshold');

  const { rowStore: bigRowStore } = buildMultiRowFixture_(new Array(50).fill(1));
  const { sandbox: sandboxBig } = loadCode();
  const bigOps = [];
  const bigSheet = makeRowStoreSheet_(sandboxBig, bigRowStore, bigOps);
  const txConfigBig = sandboxBig.getSheetConfigByName_('Transactions');

  const aboveThresholdGroups = makeGroupsForDates_(
    new Array(threshold + 1).fill(0).map(function(_, i) { return addDays_('2026-01-01', i * 2 + 1); })
  );
  sandboxBig.findInsertionRowsForGroups_(bigSheet, txConfigBig, aboveThresholdGroups);
  const bigFullReads = bigOps.filter(function(op) { return op.type === 'getValues' && op.numRows >= 50; });
  assert.equal(bigFullReads.length, 1, 'above the threshold, expected exactly one full anchor read for the whole batch');
});

test('batchInsertEntitiesIntoSheet_ produces the same insertion rows via the fast path and the anchors fallback', () => {
  const { rowStore } = buildMultiRowFixture_([1, 2, 1, 3, 1, 2, 1, 1, 4, 1]);
  const dates = ['2026-01-01', '2026-01-03', '2026-01-05', '2026-01-07', '2026-01-09'];

  const { sandbox: sandboxFast } = loadCode();
  const fastSheet = makeRowStoreSheet_(sandboxFast, new Map(rowStore), []);
  const txConfigFast = sandboxFast.getSheetConfigByName_('Transactions');
  const fastGroups = makeGroupsForDates_(dates);
  assert.ok(fastGroups.length <= sandboxFast.ANCHOR_BATCH_FAST_THRESHOLD_);
  const fastRows = sandboxFast.findInsertionRowsForGroups_(fastSheet, txConfigFast, fastGroups);

  const { sandbox: sandboxSlow } = loadCode();
  const slowSheet = makeRowStoreSheet_(sandboxSlow, new Map(rowStore), []);
  const txConfigSlow = sandboxSlow.getSheetConfigByName_('Transactions');
  const anchors = sandboxSlow.buildEntityAnchors_(slowSheet, txConfigSlow);
  const slowRows = dates.map(function(date) {
    return sandboxSlow.findInsertionRowFromAnchors_(anchors, date);
  });

  assert.deepEqual(fastRows, slowRows);
});

// --- batchInsertEntitiesIntoSheet_ (new insert) / applyEntityUpdateToSheet_ (existing) ---

function makeReplacementRows_(sandbox, overrides) {
  overrides = overrides || {};
  const rows = sandbox.flattenTransactionForSheet_(sampleTransaction(overrides.txn || {}), {
    'accounts/source': '[A] Bank - Checking',
    'accounts/food': '[X] Food',
  });
  rows.forEach(function(row) { row.split_off_amount = ''; });
  return rows;
}

test('batchInsertEntitiesIntoSheet_ inserts new entity mid-sheet at date-sorted position', () => {
  const operations = [];
  const rowStore = new Map([
    [2, { resource_name: 'transactions/txn_a', transaction_date: '2026-04-19', payee: 'A' }],
    [3, { resource_name: 'transactions/txn_b', transaction_date: '2026-04-21', payee: 'B' }],
  ]);
  const { sandbox } = loadCode();
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, operations);
  const txConfig = sandbox.getSheetConfigByName_('Transactions');
  const replacementRows = makeReplacementRows_(sandbox, { txn: { transaction_date: '2026-04-20', name: 'transactions/txn_new' } });

  const spans = sandbox.batchInsertEntitiesIntoSheet_(
    [{ rows: replacementRows, entityDate: sandbox.normalizeEntityDate_(replacementRows[0].transaction_date) }],
    fakeSheet, txConfig
  );

  assert.deepEqual(JSON.parse(JSON.stringify(spans[0])), { start: 3, count: 1 });
  assert.equal(rowStore.get(3).resource_name, 'transactions/txn_new');
  assert.equal(rowStore.get(4).resource_name, 'transactions/txn_b');
});

test('batchInsertEntitiesIntoSheet_ appends new entity when date is after all existing', () => {
  const operations = [];
  const rowStore = new Map([
    [2, { resource_name: 'transactions/txn_a', transaction_date: '2026-04-19', payee: 'A' }],
  ]);
  const { sandbox } = loadCode();
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, operations);
  const txConfig = sandbox.getSheetConfigByName_('Transactions');
  const replacementRows = makeReplacementRows_(sandbox, { txn: { transaction_date: '2026-04-25', name: 'transactions/txn_new' } });

  const spans = sandbox.batchInsertEntitiesIntoSheet_(
    [{ rows: replacementRows, entityDate: sandbox.normalizeEntityDate_(replacementRows[0].transaction_date) }],
    fakeSheet, txConfig
  );

  assert.deepEqual(JSON.parse(JSON.stringify(spans[0])), { start: 3, count: 1 });
  assert.equal(rowStore.get(3).resource_name, 'transactions/txn_new');
});

test('batchInsertEntitiesIntoSheet_ writes to row 2 when sheet is empty', () => {
  const operations = [];
  const rowStore = new Map();
  const { sandbox } = loadCode();
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, operations);
  const txConfig = sandbox.getSheetConfigByName_('Transactions');
  const replacementRows = makeReplacementRows_(sandbox);

  const spans = sandbox.batchInsertEntitiesIntoSheet_(
    [{ rows: replacementRows, entityDate: sandbox.normalizeEntityDate_(replacementRows[0].transaction_date) }],
    fakeSheet, txConfig
  );

  assert.deepEqual(JSON.parse(JSON.stringify(spans[0])), { start: 2, count: 1 });
  assert.equal(rowStore.get(2).resource_name, 'transactions/txn_1');
});

test('applyEntityUpdateToSheet_ deletes excess rows when posting count decreases', () => {
  const operations = [];
  const rowStore = new Map([
    [2, { resource_name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: 'Migros',
          narration: 'Groceries', source_account_name: '[A] Bank - Checking', destination_account_name: '[X] Food',
          amount: 50, symbol: 'CHF', split_off_amount: '', issues: '' }],
    [3, { resource_name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: 'Migros',
          narration: 'Groceries', source_account_name: '[A] Bank - Checking', destination_account_name: '[X] Household',
          amount: 34.25, symbol: 'CHF', split_off_amount: '', issues: '' }],
    [4, { resource_name: 'transactions/txn_other', transaction_date: '2026-04-21', payee: 'Other' }],
  ]);
  const { sandbox } = loadCode();
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, operations);
  const txConfig = sandbox.getSheetConfigByName_('Transactions');
  const replacementRows = makeReplacementRows_(sandbox);

  const result = sandbox.applyEntityUpdateToSheet_(fakeSheet, txConfig, { start: 2, count: 2 }, replacementRows);

  assert.deepEqual(JSON.parse(JSON.stringify(result)), { start: 2, count: 1 });
  assert.equal(rowStore.get(2).resource_name, 'transactions/txn_1');
  assert.equal(rowStore.get(3).resource_name, 'transactions/txn_other');
  const deleteOps = operations.filter(function(op) { return op.type === 'deleteRows'; });
  assert.equal(deleteOps.length, 1);
});

test('applyEntityUpdateToSheet_ inserts rows when posting count increases', () => {
  const operations = [];
  const rowStore = new Map([
    [2, { resource_name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: 'Migros',
          narration: 'Groceries', source_account_name: '[A] Bank - Checking', destination_account_name: '[X] Food',
          amount: 84.25, symbol: 'CHF', split_off_amount: '', issues: '' }],
    [3, { resource_name: 'transactions/txn_other', transaction_date: '2026-04-21', payee: 'Other' }],
  ]);
  const { sandbox } = loadCode();
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, operations);
  const txConfig = sandbox.getSheetConfigByName_('Transactions');
  const splitTxn = sampleTransaction({ postings: [
    { account: 'accounts/source', units: { amount: '-84.25', symbol: 'CHF' } },
    { account: 'accounts/food', units: { amount: '50', symbol: 'CHF' } },
    { account: 'accounts/household', units: { amount: '34.25', symbol: 'CHF' } },
  ]});
  const replacementRows = sandbox.flattenTransactionForSheet_(splitTxn, {
    'accounts/source': '[A] Bank - Checking',
    'accounts/food': '[X] Food',
    'accounts/household': '[X] Household',
  });
  replacementRows.forEach(function(row) { row.split_off_amount = ''; });

  const result = sandbox.applyEntityUpdateToSheet_(fakeSheet, txConfig, { start: 2, count: 1 }, replacementRows);

  assert.deepEqual(JSON.parse(JSON.stringify(result)), { start: 2, count: 2 });
  assert.equal(rowStore.get(2).resource_name, 'transactions/txn_1');
  assert.equal(rowStore.get(3).resource_name, 'transactions/txn_1');
  assert.equal(rowStore.get(4).resource_name, 'transactions/txn_other');
  const insertOps = operations.filter(function(op) { return op.type === 'insertRowsAfter'; });
  assert.equal(insertOps.length, 1);
});

test('applyEntityUpdateToSheet_ updates rows in-place when span count matches', () => {
  const operations = [];
  const rowStore = new Map([
    [2, { resource_name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: 'Old Payee',
          narration: 'Groceries', source_account_name: '[A] Bank - Checking', destination_account_name: '[X] Food',
          amount: 84.25, symbol: 'CHF', split_off_amount: '', issues: '' }],
  ]);
  const { sandbox } = loadCode();
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, operations);
  const txConfig = sandbox.getSheetConfigByName_('Transactions');
  const replacementRows = makeReplacementRows_(sandbox);

  sandbox.applyEntityUpdateToSheet_(fakeSheet, txConfig, { start: 2, count: 1 }, replacementRows);

  assert.equal(rowStore.get(2).payee, 'Migros');
});

test('applyEntityUpdateToSheet_ deletes existing span when rows are empty', () => {
  const operations = [];
  const rowStore = new Map([
    [2, { resource_name: 'balanceAssertions/bal_1', assertion_date: '2026-04-19' }],
    [3, { resource_name: 'balanceAssertions/bal_2', assertion_date: '2026-04-25' }],
  ]);
  const { sandbox } = loadCode();
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, operations, 'Balances');
  const balConfig = sandbox.getSheetConfigByName_('Balances');

  const result = sandbox.applyEntityUpdateToSheet_(fakeSheet, balConfig, { start: 2, count: 1 }, []);

  assert.equal(result, null);
  const deleteOps = operations.filter(function(op) { return op.type === 'deleteRows'; });
  assert.equal(deleteOps.length, 1);
});

function makeThreeRowStore_() {
  return new Map([
    [2, { resource_name: 'transactions/txn_a', transaction_date: '2026-04-17', payee: 'A',
          narration: '', narration_source: 'txn', source_account_name: '', destination_account_name: '',
          amount: '', symbol: '', split_off_amount: '', issues: '' }],
    [3, { resource_name: 'transactions/txn_b', transaction_date: '2026-04-21', payee: 'B',
          narration: '', narration_source: 'txn', source_account_name: '', destination_account_name: '',
          amount: '', symbol: '', split_off_amount: '', issues: '' }],
    [4, { resource_name: 'transactions/txn_c', transaction_date: '2026-04-25', payee: 'C',
          narration: '', narration_source: 'txn', source_account_name: '', destination_account_name: '',
          amount: '', symbol: '', split_off_amount: '', issues: '' }],
  ]);
}

test('applyEntityUpdateToSheet_ repositions entity when date moves earlier', () => {
  const operations = [];
  const rowStore = makeThreeRowStore_();
  const { sandbox } = loadCode();
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, operations);
  const txConfig = sandbox.getSheetConfigByName_('Transactions');
  const replacementRows = makeReplacementRows_(sandbox, { txn: { transaction_date: '2026-04-18', name: 'transactions/txn_c' } });

  const result = sandbox.applyEntityUpdateToSheet_(fakeSheet, txConfig, { start: 4, count: 1 }, replacementRows);

  assert.deepEqual(JSON.parse(JSON.stringify(result)), { start: 3, count: 1 });
  assert.equal(rowStore.get(3).resource_name, 'transactions/txn_c');
  assert.equal(rowStore.get(4).resource_name, 'transactions/txn_b');
});

test('applyEntityUpdateToSheet_ repositions entity when date moves later', () => {
  const operations = [];
  const rowStore = makeThreeRowStore_();
  const { sandbox } = loadCode();
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, operations);
  const txConfig = sandbox.getSheetConfigByName_('Transactions');
  const replacementRows = makeReplacementRows_(sandbox, { txn: { transaction_date: '2026-04-24', name: 'transactions/txn_a' } });

  const result = sandbox.applyEntityUpdateToSheet_(fakeSheet, txConfig, { start: 2, count: 1 }, replacementRows);

  assert.deepEqual(JSON.parse(JSON.stringify(result)), { start: 3, count: 1 });
  assert.equal(rowStore.get(2).resource_name, 'transactions/txn_b');
  assert.equal(rowStore.get(3).resource_name, 'transactions/txn_a');
  assert.equal(rowStore.get(4).resource_name, 'transactions/txn_c');
});

test('applyEntityUpdateToSheet_ does not reposition when date is unchanged', () => {
  const operations = [];
  const rowStore = makeThreeRowStore_();
  rowStore.get(2).source_account_name = '[A] Bank - Checking';
  rowStore.get(2).destination_account_name = '[X] Food';
  rowStore.get(2).amount = 84.25;
  rowStore.get(2).symbol = 'CHF';
  const { sandbox } = loadCode();
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, operations);
  const txConfig = sandbox.getSheetConfigByName_('Transactions');
  const replacementRows = makeReplacementRows_(sandbox, { txn: { transaction_date: '2026-04-17', name: 'transactions/txn_a' } });

  sandbox.applyEntityUpdateToSheet_(fakeSheet, txConfig, { start: 2, count: 1 }, replacementRows);

  const insertOps = operations.filter(function(op) { return op.type === 'insertRowsAfter'; });
  const deleteOps = operations.filter(function(op) { return op.type === 'deleteRows'; });
  assert.equal(insertOps.length, 0);
  assert.equal(deleteOps.length, 0);
  assert.equal(rowStore.get(2).resource_name, 'transactions/txn_a');
});
