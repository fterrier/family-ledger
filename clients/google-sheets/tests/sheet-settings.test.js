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
  sandbox.readCommoditySheetEntries_ = function() {
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
  sandbox.readCommoditySheetEntries_ = function() {
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
  sandbox.readCommoditySheetEntries_ = function() {
    return [{ symbol: 'CHF' }, { symbol: 'EUR' }];
  };

  assert.throws(() => sandbox.saveSheetSettingsFromDialog(
    ['accounts/cash'],
    ['CHF'],
    'accounts/cash',
    'EUR'
  ), /Default symbol must be part of the quick add symbol shortlist/);
});

test('saveSheetSettingsFromDialog stores destination accounts shortlist', () => {
  const { sandbox, documentProperties } = loadCode();
  sandbox.readAccountSheetEntries_ = function() {
    return [
      { resourceName: 'accounts/food', displayName: '[X] Food' },
      { resourceName: 'accounts/coffee', displayName: '[X] Coffee' },
      { resourceName: 'accounts/cash', displayName: '[A] Cash' },
    ];
  };
  sandbox.readCommoditySheetEntries_ = function() {
    return [{ symbol: 'CHF' }];
  };

  sandbox.saveSheetSettingsFromDialog(
    ['accounts/cash'], ['CHF'], 'accounts/cash', 'CHF',
    ['accounts/food', 'accounts/coffee']
  );

  assert.equal(
    documentProperties.get('QUICK_ADD_DESTINATION_ACCOUNTS'),
    '["accounts/food","accounts/coffee"]'
  );
});

test('saveSheetSettingsFromDialog rejects destination account not in account list', () => {
  const { sandbox } = loadCode();
  sandbox.readAccountSheetEntries_ = function() {
    return [{ resourceName: 'accounts/cash', displayName: '[A] Cash' }];
  };
  sandbox.readCommoditySheetEntries_ = function() {
    return [{ symbol: 'CHF' }];
  };

  assert.throws(() => sandbox.saveSheetSettingsFromDialog(
    ['accounts/cash'], ['CHF'], 'accounts/cash', 'CHF',
    ['accounts/unknown']
  ), /Unknown quick add destination account/);
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
