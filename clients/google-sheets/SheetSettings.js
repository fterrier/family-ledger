const FAMILY_LEDGER_DOC_PROP_QUICK_ADD_SOURCE_ACCOUNTS = 'QUICK_ADD_SOURCE_ACCOUNTS';
const FAMILY_LEDGER_DOC_PROP_QUICK_ADD_SYMBOLS = 'QUICK_ADD_SYMBOLS';
const FAMILY_LEDGER_DOC_PROP_QUICK_ADD_DEFAULT_SOURCE_ACCOUNT = 'QUICK_ADD_DEFAULT_SOURCE_ACCOUNT';
const FAMILY_LEDGER_DOC_PROP_QUICK_ADD_DEFAULT_SYMBOL = 'QUICK_ADD_DEFAULT_SYMBOL';
const FAMILY_LEDGER_DOC_PROP_QUICK_ADD_DESTINATION_ACCOUNTS = 'QUICK_ADD_DESTINATION_ACCOUNTS';

function showSheetSettings() {
  const html = HtmlService.createHtmlOutputFromFile('SheetSettingsDialog')
    .setWidth(520)
    .setHeight(560);
  SpreadsheetApp.getUi().showModalDialog(html, 'Sheet Settings');
}


function getDocPropJsonArray_(propKey) {
  const rawValue = PropertiesService.getDocumentProperties().getProperty(propKey);
  if (!rawValue) return [];
  try {
    const parsed = JSON.parse(rawValue);
    return Array.isArray(parsed)
      ? parsed.map(function(value) { return String(value || '').trim(); }).filter(Boolean)
      : [];
  } catch (_error) { return []; }
}

function getQuickAddDefaultSourceAccount_() {
  return String(
    PropertiesService.getDocumentProperties().getProperty(
      FAMILY_LEDGER_DOC_PROP_QUICK_ADD_DEFAULT_SOURCE_ACCOUNT
    ) || ''
  ).trim();
}

function getQuickAddDefaultSymbol_() {
  return String(
    PropertiesService.getDocumentProperties().getProperty(
      FAMILY_LEDGER_DOC_PROP_QUICK_ADD_DEFAULT_SYMBOL
    ) || ''
  ).trim();
}

function readCommoditySheetEntries_() {
  const sheet = getOrCreateSheet_(FAMILY_LEDGER_SHEET_NAMES.commodities);
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [];
  return managedSheet_(sheet, FAMILY_LEDGER_SHEET_REGISTRY.commodities)
    .getRows({ start: 2, count: lastRow - 1 }, ['symbol'])
    .map(function(row) { return { symbol: String(row.symbol || '').trim() }; })
    .filter(function(entry) { return entry.symbol; });
}

function listCommodityOptions_() {
  try {
    return readCommoditySheetEntries_().sort(function(left, right) {
      return left.symbol.localeCompare(right.symbol);
    });
  } catch (_error) {
    return [];
  }
}

function getAllQuickAddSettings_() {
  const props = PropertiesService.getDocumentProperties().getProperties();
  function parseJsonArray(key) {
    const rawValue = props[key];
    if (!rawValue) return [];
    try {
      const parsed = JSON.parse(rawValue);
      return Array.isArray(parsed)
        ? parsed.map(function(v) { return String(v || '').trim(); }).filter(Boolean)
        : [];
    } catch (_error) { return []; }
  }
  return {
    sourceAccounts: parseJsonArray(FAMILY_LEDGER_DOC_PROP_QUICK_ADD_SOURCE_ACCOUNTS),
    destinationAccounts: parseJsonArray(FAMILY_LEDGER_DOC_PROP_QUICK_ADD_DESTINATION_ACCOUNTS),
    symbols: parseJsonArray(FAMILY_LEDGER_DOC_PROP_QUICK_ADD_SYMBOLS),
    defaultSourceAccount: String(props[FAMILY_LEDGER_DOC_PROP_QUICK_ADD_DEFAULT_SOURCE_ACCOUNT] || '').trim(),
    defaultSymbol: String(props[FAMILY_LEDGER_DOC_PROP_QUICK_ADD_DEFAULT_SYMBOL] || '').trim(),
  };
}

function buildQuickAddSymbolOptions_(commodityOptions, selectedSymbols) {
  const allowed = Array.isArray(selectedSymbols) ? selectedSymbols : [];
  return commodityOptions.filter(function(option) {
    return allowed.indexOf(option.symbol) !== -1;
  });
}

function resolveQuickAddDefaultSymbol_(selectedSymbols, defaultSymbol) {
  const allowed = Array.isArray(selectedSymbols) ? selectedSymbols : [];
  const normalizedDefault = String(defaultSymbol || '').trim();
  return allowed.indexOf(normalizedDefault) !== -1 ? normalizedDefault : '';
}

function getSheetSettingsForDialog() {
  const commodities = listCommodityOptions_();
  const quickAddSymbols = getDocPropJsonArray_(FAMILY_LEDGER_DOC_PROP_QUICK_ADD_SYMBOLS);
  return {
    accounts: loadAccountOptions_(),
    commodities: commodities,
    quickAddSourceAccounts: getDocPropJsonArray_(FAMILY_LEDGER_DOC_PROP_QUICK_ADD_SOURCE_ACCOUNTS),
    quickAddDestinationAccounts: getDocPropJsonArray_(FAMILY_LEDGER_DOC_PROP_QUICK_ADD_DESTINATION_ACCOUNTS),
    quickAddSymbols: quickAddSymbols,
    defaultSourceAccount: getQuickAddDefaultSourceAccount_(),
    defaultSymbol: resolveQuickAddDefaultSymbol_(quickAddSymbols, getQuickAddDefaultSymbol_()),
  };
}

function saveSheetSettingsFromDialog(sourceAccounts, quickAddSymbols, defaultSourceAccount, defaultSymbol, destinationAccounts) {
  const knownAccounts = new Set(loadAccountOptions_().map(function(o) { return o.resource_name; }));
  const commodityOptions = listCommodityOptions_();
  const knownSymbols = new Set(commodityOptions.map(function(option) {
    return option.symbol;
  }));
  const normalizedSourceAccounts = Array.isArray(sourceAccounts)
    ? sourceAccounts.map(function(value) {
      return String(value || '').trim();
    }).filter(Boolean)
    : [];
  const normalizedSymbols = Array.isArray(quickAddSymbols)
    ? quickAddSymbols.map(function(value) {
      return String(value || '').trim();
    }).filter(Boolean)
    : [];
  const normalizedDestinationAccounts = Array.isArray(destinationAccounts)
    ? destinationAccounts.map(function(value) {
      return String(value || '').trim();
    }).filter(Boolean)
    : [];

  normalizedSourceAccounts.forEach(function(accountResourceName) {
    if (!knownAccounts.has(accountResourceName)) {
      throw new Error('Unknown quick add source account: ' + accountResourceName);
    }
  });
  normalizedDestinationAccounts.forEach(function(accountResourceName) {
    if (!knownAccounts.has(accountResourceName)) {
      throw new Error('Unknown quick add destination account: ' + accountResourceName);
    }
  });
  normalizedSymbols.forEach(function(symbol) {
    if (!knownSymbols.has(symbol)) {
      throw new Error('Unknown quick add symbol: ' + symbol);
    }
  });

  const uniqueSourceAccounts = [];
  normalizedSourceAccounts.forEach(function(accountResourceName) {
    if (uniqueSourceAccounts.indexOf(accountResourceName) === -1) {
      uniqueSourceAccounts.push(accountResourceName);
    }
  });
  const uniqueDestinationAccounts = [];
  normalizedDestinationAccounts.forEach(function(accountResourceName) {
    if (uniqueDestinationAccounts.indexOf(accountResourceName) === -1) {
      uniqueDestinationAccounts.push(accountResourceName);
    }
  });
  const uniqueSymbols = [];
  normalizedSymbols.forEach(function(symbol) {
    if (uniqueSymbols.indexOf(symbol) === -1) {
      uniqueSymbols.push(symbol);
    }
  });

  const normalizedDefaultSourceAccount = String(defaultSourceAccount || '').trim();
  if (
    normalizedDefaultSourceAccount &&
    uniqueSourceAccounts.indexOf(normalizedDefaultSourceAccount) === -1
  ) {
    throw new Error('Default source account must be part of the quick add source account shortlist.');
  }

  const normalizedDefaultSymbol = String(defaultSymbol || '').trim();
  if (normalizedDefaultSymbol && uniqueSymbols.indexOf(normalizedDefaultSymbol) === -1) {
    throw new Error('Default symbol must be part of the quick add symbol shortlist.');
  }
  const properties = PropertiesService.getDocumentProperties();
  properties.setProperty(
    FAMILY_LEDGER_DOC_PROP_QUICK_ADD_SOURCE_ACCOUNTS,
    JSON.stringify(uniqueSourceAccounts)
  );
  properties.setProperty(
    FAMILY_LEDGER_DOC_PROP_QUICK_ADD_DESTINATION_ACCOUNTS,
    JSON.stringify(uniqueDestinationAccounts)
  );
  properties.setProperty(
    FAMILY_LEDGER_DOC_PROP_QUICK_ADD_SYMBOLS,
    JSON.stringify(uniqueSymbols)
  );
  if (normalizedDefaultSourceAccount) {
    properties.setProperty(
      FAMILY_LEDGER_DOC_PROP_QUICK_ADD_DEFAULT_SOURCE_ACCOUNT,
      normalizedDefaultSourceAccount
    );
  } else {
    properties.deleteProperty(FAMILY_LEDGER_DOC_PROP_QUICK_ADD_DEFAULT_SOURCE_ACCOUNT);
  }
  if (normalizedDefaultSymbol) {
    properties.setProperty(FAMILY_LEDGER_DOC_PROP_QUICK_ADD_DEFAULT_SYMBOL, normalizedDefaultSymbol);
  } else {
    properties.deleteProperty(FAMILY_LEDGER_DOC_PROP_QUICK_ADD_DEFAULT_SYMBOL);
  }
}
