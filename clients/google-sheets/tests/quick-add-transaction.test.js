const test = require('node:test');
const assert = require('node:assert/strict');

const { loadCode, makeRowStoreSheet_ } = require('./_harness');

test('searchAccountEntries_ matches ordered-character queries like foco', () => {
  const { sandbox } = loadCode();

  const matches = JSON.parse(JSON.stringify(sandbox.searchAccountEntries_([
    sandbox.buildAccountSearchEntry_({
      resource_name: 'accounts/coop',
      display_name: '[X] Family - Food - Coop',
    }),
    sandbox.buildAccountSearchEntry_({
      resource_name: 'accounts/coffee',
      display_name: '[X] Family - Coffee',
    }),
  ], 'foco', 8)));

  assert.equal(matches[0].resource_name, 'accounts/coop');
});

test('searchAccountEntries_ treats spaces as normal ordered characters', () => {
  const { sandbox } = loadCode();

  const matches = JSON.parse(JSON.stringify(sandbox.searchAccountEntries_([
    sandbox.buildAccountSearchEntry_({
      resource_name: 'accounts/coop',
      display_name: '[A] Family - Food - Coop',
    }),
  ], 'f fo c', 8)));

  assert.equal(matches[0].resource_name, 'accounts/coop');
});

test('searchAccountEntries_ preserves original order of matching accounts', () => {
  const { sandbox } = loadCode();

  const matches = JSON.parse(JSON.stringify(sandbox.searchAccountEntries_([
    sandbox.buildAccountSearchEntry_({
      resource_name: 'accounts/first',
      display_name: '[A] Family - Food - Coop',
    }),
    sandbox.buildAccountSearchEntry_({
      resource_name: 'accounts/second',
      display_name: '[A] Family - Finance - Core',
    }),
  ], 'ffc', 8)));

  assert.deepEqual(matches.map(function(entry) { return entry.resource_name; }), [
    'accounts/first',
    'accounts/second',
  ]);
});

test('searchAccountEntries_ returns all matching accounts without a hard cap', () => {
  const { sandbox } = loadCode();

  const entries = [];
  for (let index = 0; index < 12; index += 1) {
    entries.push(sandbox.buildAccountSearchEntry_({
      resource_name: 'accounts/match_' + index,
      display_name: '[X] Family - FoodWineHousehold - Coop ' + index,
    }));
  }
  const matches = sandbox.searchAccountEntries_(entries, 'ffoc');

  assert.equal(matches.length, 12);
});

test('isOrderedCharacterMatch_ rejects characters that do not appear in order', () => {
  const { sandbox } = loadCode();

  assert.equal(sandbox.isOrderedCharacterMatch_('fzc', '[A] Family - Food - Coop'), false);
});

test('saveSheetSettingsFromDialog stores shortlist, default source account, and symbol', () => {
  const { sandbox, documentProperties } = loadCode();
  sandbox.readAccountSheetEntries_ = function() {
    return [
      { resourceName: 'accounts/cash', displayName: '[A] Liquid - Cash' },
      { resourceName: 'accounts/checking', displayName: '[A] Bank - Checking' },
    ];
  };
  sandbox.fetchFamilyLedgerPagedResource_ = function(path, resourceKey) {
    assert.equal(path, '/commodities?page_size=1000');
    assert.equal(resourceKey, 'commodities');
    return [{ symbol: 'CHF' }, { symbol: 'EUR' }];
  };

  sandbox.saveSheetSettingsFromDialog(
    ['accounts/cash', 'accounts/checking'],
    ['CHF', 'EUR'],
    'accounts/cash',
    'CHF'
  );

  assert.equal(documentProperties.get('QUICK_ADD_SOURCE_ACCOUNTS'), '["accounts/cash","accounts/checking"]');
  assert.equal(documentProperties.get('QUICK_ADD_SYMBOLS'), '["CHF","EUR"]');
  assert.equal(documentProperties.get('QUICK_ADD_DEFAULT_SOURCE_ACCOUNT'), 'accounts/cash');
  assert.equal(documentProperties.get('QUICK_ADD_DEFAULT_SYMBOL'), 'CHF');
});

test('saveSheetSettingsFromDialog rejects default source account outside shortlist', () => {
  const { sandbox } = loadCode();
  sandbox.readAccountSheetEntries_ = function() {
    return [
      { resourceName: 'accounts/cash', displayName: '[A] Liquid - Cash' },
      { resourceName: 'accounts/checking', displayName: '[A] Bank - Checking' },
    ];
  };
  sandbox.fetchFamilyLedgerPagedResource_ = function() {
    return [{ symbol: 'CHF' }];
  };

  assert.throws(() => sandbox.saveSheetSettingsFromDialog(
    ['accounts/checking'],
    ['CHF'],
    'accounts/cash',
    'CHF'
  ), /must be part of the quick add source account shortlist/);
});

test('saveSheetSettingsFromDialog rejects default symbol outside configured symbol shortlist', () => {
  const { sandbox } = loadCode();
  sandbox.readAccountSheetEntries_ = function() {
    return [
      { resourceName: 'accounts/cash', displayName: '[A] Liquid - Cash' },
    ];
  };
  sandbox.fetchFamilyLedgerPagedResource_ = function() {
    return [{ symbol: 'CHF' }, { symbol: 'EUR' }];
  };

  assert.throws(() => sandbox.saveSheetSettingsFromDialog(
    ['accounts/cash'],
    ['CHF'],
    'accounts/cash',
    'EUR'
  ), /Default symbol must be part of the quick add symbol shortlist/);
});

test('getQuickAddTransactionData only exposes configured source accounts and symbols', () => {
  const { sandbox, documentProperties } = loadCode();
  sandbox.readAccountSheetEntries_ = function() {
    return [
      { resourceName: 'accounts/cash', displayName: '[A] Liquid - Cash' },
      { resourceName: 'accounts/checking', displayName: '[A] Bank - Checking' },
      { resourceName: 'accounts/food', displayName: '[X] Food' },
    ];
  };
  sandbox.fetchFamilyLedgerPagedResource_ = function(path, resourceKey) {
    assert.equal(path, '/commodities?page_size=1000');
    assert.equal(resourceKey, 'commodities');
    return [{ symbol: 'CHF' }, { symbol: 'EUR' }, { symbol: 'USD' }];
  };
  documentProperties.set('QUICK_ADD_SOURCE_ACCOUNTS', '["accounts/cash","accounts/checking"]');
  documentProperties.set('QUICK_ADD_SYMBOLS', '["CHF","EUR"]');
  documentProperties.set('QUICK_ADD_DEFAULT_SOURCE_ACCOUNT', 'accounts/checking');
  documentProperties.set('QUICK_ADD_DEFAULT_SYMBOL', 'EUR');

  const data = JSON.parse(JSON.stringify(sandbox.getQuickAddTransactionData()));

  assert.deepEqual(data.sourceAccountOptions, [
    { resource_name: 'accounts/checking', display_name: '[A] Bank - Checking' },
    { resource_name: 'accounts/cash', display_name: '[A] Liquid - Cash' },
  ]);
  assert.deepEqual(data.commodityOptions, [
    { symbol: 'CHF' },
    { symbol: 'EUR' },
  ]);
  assert.equal(data.defaultSourceAccount, 'accounts/checking');
  assert.equal(data.defaultSymbol, 'EUR');
  assert.equal(data.configured, true);
});

test('buildQuickAddSymbolOptions_ filters commodity options to configured shortlist', () => {
  const { sandbox } = loadCode();

  const options = JSON.parse(JSON.stringify(sandbox.buildQuickAddSymbolOptions_([
    { symbol: 'CHF' },
    { symbol: 'EUR' },
    { symbol: 'USD' },
  ], ['CHF', 'USD'])));

  assert.deepEqual(options, [
    { symbol: 'CHF' },
    { symbol: 'USD' },
  ]);
});

test('resolveQuickAddDefaultSymbol_ clears defaults outside the selected symbol shortlist', () => {
  const { sandbox } = loadCode();

  assert.equal(sandbox.resolveQuickAddDefaultSymbol_(['CHF', 'EUR'], 'EUR'), 'EUR');
  assert.equal(sandbox.resolveQuickAddDefaultSymbol_(['CHF'], 'EUR'), '');
  assert.equal(sandbox.resolveQuickAddDefaultSymbol_([], 'CHF'), '');
});

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
