const test = require('node:test');
const assert = require('node:assert/strict');

const { loadCode } = require('./_harness');

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
