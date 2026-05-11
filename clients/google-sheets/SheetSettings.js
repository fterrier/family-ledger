const FAMILY_LEDGER_DOC_PROP_QUICK_ADD_SOURCE_ACCOUNTS = 'QUICK_ADD_SOURCE_ACCOUNTS';
const FAMILY_LEDGER_DOC_PROP_QUICK_ADD_SYMBOLS = 'QUICK_ADD_SYMBOLS';
const FAMILY_LEDGER_DOC_PROP_QUICK_ADD_DEFAULT_SOURCE_ACCOUNT = 'QUICK_ADD_DEFAULT_SOURCE_ACCOUNT';
const FAMILY_LEDGER_DOC_PROP_QUICK_ADD_DEFAULT_SYMBOL = 'QUICK_ADD_DEFAULT_SYMBOL';
const FAMILY_LEDGER_DOC_PROP_QUICK_ADD_DESTINATION_PREFIX = 'QUICK_ADD_DESTINATION_PREFIX';

function showSheetSettings() {
  const html = HtmlService.createHtmlOutputFromFile('SheetSettingsDialog')
    .setWidth(520)
    .setHeight(520);
  SpreadsheetApp.getUi().showModalDialog(html, 'Sheet Settings');
}

function listAccountOptions_() {
  try {
    return readAccountSheetEntries_().map(function(entry) {
      return {
        resource_name: entry.resourceName,
        display_name: entry.displayName,
      };
    }).sort(function(left, right) {
      return left.display_name.localeCompare(right.display_name);
    });
  } catch (_error) {
    return [];
  }
}

function getQuickAddSourceAccountResources_() {
  const rawValue = PropertiesService.getDocumentProperties().getProperty(
    FAMILY_LEDGER_DOC_PROP_QUICK_ADD_SOURCE_ACCOUNTS
  );
  if (!rawValue) {
    return [];
  }
  try {
    const parsed = JSON.parse(rawValue);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.map(function(value) {
      return String(value || '').trim();
    }).filter(Boolean);
  } catch (_error) {
    return [];
  }
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

function listCommodityOptions_() {
  try {
    return fetchFamilyLedgerPagedResource_(
      '/commodities?page_size=' + FAMILY_LEDGER_PAGE_SIZE,
      'commodities'
    ).map(function(commodity) {
      return { symbol: commodity.symbol };
    }).sort(function(left, right) {
      return left.symbol.localeCompare(right.symbol);
    });
  } catch (_error) {
    return [];
  }
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

function getQuickAddDestinationPrefix_() {
  return String(
    PropertiesService.getDocumentProperties().getProperty(
      FAMILY_LEDGER_DOC_PROP_QUICK_ADD_DESTINATION_PREFIX
    ) || ''
  ).trim();
}

function getQuickAddSymbols_() {
  const rawValue = PropertiesService.getDocumentProperties().getProperty(
    FAMILY_LEDGER_DOC_PROP_QUICK_ADD_SYMBOLS
  );
  if (!rawValue) {
    return [];
  }
  try {
    const parsed = JSON.parse(rawValue);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.map(function(value) {
      return String(value || '').trim();
    }).filter(Boolean);
  } catch (_error) {
    return [];
  }
}

function getSheetSettingsForDialog() {
  const commodities = listCommodityOptions_();
  const quickAddSymbols = getQuickAddSymbols_();
  return {
    accounts: listAccountOptions_(),
    commodities: commodities,
    quickAddSourceAccounts: getQuickAddSourceAccountResources_(),
    quickAddSymbols: quickAddSymbols,
    defaultSourceAccount: getQuickAddDefaultSourceAccount_(),
    defaultSymbol: resolveQuickAddDefaultSymbol_(quickAddSymbols, getQuickAddDefaultSymbol_()),
    destinationPrefix: getQuickAddDestinationPrefix_(),
  };
}

function saveSheetSettingsFromDialog(sourceAccounts, quickAddSymbols, defaultSourceAccount, defaultSymbol, destinationPrefix) {
  const accountOptions = listAccountOptions_();
  const knownAccounts = new Set(accountOptions.map(function(option) {
    return option.resource_name;
  }));
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

  normalizedSourceAccounts.forEach(function(accountResourceName) {
    if (!knownAccounts.has(accountResourceName)) {
      throw new Error('Unknown quick add source account: ' + accountResourceName);
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
  const normalizedPrefix = String(destinationPrefix || '').trim();
  if (normalizedPrefix) {
    properties.setProperty(FAMILY_LEDGER_DOC_PROP_QUICK_ADD_DESTINATION_PREFIX, normalizedPrefix);
  } else {
    properties.deleteProperty(FAMILY_LEDGER_DOC_PROP_QUICK_ADD_DESTINATION_PREFIX);
  }
}
