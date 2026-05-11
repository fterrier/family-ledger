const test = require('node:test');
const assert = require('node:assert/strict');

const { loadCode, makeRowStoreSheet_ } = require('./_harness');

test('buildQuickAddTransactionPayload_ creates source-only payload from visible amount', () => {
  const { sandbox } = loadCode();

  const payload = JSON.parse(JSON.stringify(sandbox.buildQuickAddTransactionPayload_({
    transaction_date: '2026-04-19',
    source_account: 'accounts/cash',
    destination_account: '',
    amount: 25,
    symbol: 'CHF',
    payee: 'Coffee',
    narration: null,
  })));

  assert.deepEqual(payload, {
    transaction_date: '2026-04-19',
    payee: 'Coffee',
    narration: null,
    entity_metadata: { source: 'google_sheets_quick_add' },
    postings: [
      {
        account: 'accounts/cash',
        units: { amount: '-25', symbol: 'CHF' },
      },
    ],
  });
});

test('buildQuickAddTransactionPayload_ creates simple two-posting payload when destination is present', () => {
  const { sandbox } = loadCode();

  const payload = JSON.parse(JSON.stringify(sandbox.buildQuickAddTransactionPayload_({
    transaction_date: '2026-04-19',
    source_account: 'accounts/cash',
    destination_account: 'accounts/food',
    amount: 25,
    symbol: 'CHF',
    payee: null,
    narration: 'Groceries',
  })));

  assert.deepEqual(payload.postings, [
    {
      account: 'accounts/cash',
      units: { amount: '-25', symbol: 'CHF' },
    },
    {
      account: 'accounts/food',
      units: { amount: '25', symbol: 'CHF' },
    },
  ]);
});

test('normalizeQuickAddTransactionInput_ requires source account to be in shortlist', () => {
  const { sandbox, documentProperties } = loadCode();
  documentProperties.set('QUICK_ADD_SOURCE_ACCOUNTS', '["accounts/cash"]');

  assert.throws(() => sandbox.normalizeQuickAddTransactionInput_({
    transaction_date: '2026-04-19',
    source_account: 'accounts/checking',
    amount: '25',
    symbol: 'CHF',
  }), /not part of the quick add shortlist/);
});

test('normalizeQuickAddTransactionInput_ rejects zero amount for quick add', () => {
  const { sandbox, documentProperties } = loadCode();
  documentProperties.set('QUICK_ADD_SOURCE_ACCOUNTS', '["accounts/cash"]');

  assert.throws(() => sandbox.normalizeQuickAddTransactionInput_({
    transaction_date: '2026-04-19',
    source_account: 'accounts/cash',
    amount: '0',
    symbol: 'CHF',
  }), /Amount must be non-zero/);
});

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

test('insertTransactionRowsAtRow_ inserts quick add row before a later transaction', () => {
  const operations = [];
  const rowStore = new Map([
    [2, {
      resource_name: 'transactions/txn_1',
      narration_source: 'txn',
      transaction_date: '2026-04-19',
      payee: 'Old',
      narration: '',
      source_account_name: '[A] Cash',
      destination_account_name: '',
      symbol: 'CHF',
      amount: 10,
      split_off_amount: '',
      status: '',
      issues: '',
      last_error: '',
    }],
    [3, {
      resource_name: 'transactions/txn_2',
      narration_source: 'txn',
      transaction_date: '2026-04-21',
      payee: 'Later',
      narration: '',
      source_account_name: '[A] Cash',
      destination_account_name: '',
      symbol: 'CHF',
      amount: 15,
      split_off_amount: '',
      status: '',
      issues: '',
      last_error: '',
    }],
  ]);
  const { sandbox } = loadCode({ SpreadsheetApp: { getActiveSpreadsheet() { return { getActiveSheet() { return null; } }; } } });
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, operations);
  sandbox.applyAccountValidationToRowNumbers_ = function(_sheet, rowNumbers) {
    operations.push({ type: 'applyValidation', rowNumbers: rowNumbers.slice() });
  };
  sandbox.ensureTransactionSheetFilter_ = function() {
    operations.push({ type: 'ensureFilter' });
  };

  const inserted = sandbox.insertTransactionRowsAtRow_(fakeSheet, 3, [{
    resource_name: 'transactions/txn_new',
    narration_source: 'txn',
    transaction_date: '2026-04-20',
    payee: 'New',
    narration: '',
    source_account_name: '[A] Cash',
    destination_account_name: '',
    symbol: 'CHF',
    amount: 12,
    split_off_amount: '',
    status: '',
    issues: '',
    last_error: '',
  }]);

  assert.deepEqual(JSON.parse(JSON.stringify(inserted)), [3]);
  assert.equal(rowStore.get(3).resource_name, 'transactions/txn_new');
  assert.equal(rowStore.get(4).resource_name, 'transactions/txn_2');
});
