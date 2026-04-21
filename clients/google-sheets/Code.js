const FAMILY_LEDGER_SHEET_NAMES = {
  accounts: 'Accounts',
  transactions: 'Transactions',
};

const FAMILY_LEDGER_TRANSACTION_HEADERS = [
  'transaction_name',
  'transaction_date',
  'payee',
  'narration',
  'source_account_name',
  'category_account_name',
  'amount',
  'symbol',
  'split_postings_json',
  'status',
  'last_error',
  'original_transaction_json',
];

const FAMILY_LEDGER_ACCOUNTS_HEADERS = ['account_name', 'name'];

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Family Ledger')
    .addItem('Set API Base URL', 'setFamilyLedgerBaseUrl')
    .addItem('Set API Token', 'setFamilyLedgerApiToken')
    .addItem('Show Current Settings', 'showFamilyLedgerSettings')
    .addItem('Test Connection', 'testFamilyLedgerConnection')
    .addSeparator()
    .addItem('Sync Accounts', 'syncFamilyLedgerAccounts')
    .addItem('Sync Transactions', 'syncFamilyLedgerTransactions')
    .addSeparator()
    .addItem('Push Active Row', 'pushActiveFamilyLedgerTransactionRow')
    .addToUi();
}

function setFamilyLedgerBaseUrl() {
  const ui = SpreadsheetApp.getUi();
  const currentValue = getFamilyLedgerBaseUrl_();
  const response = ui.prompt(
    'Family Ledger API Base URL',
    currentValue || 'http://localhost:8000',
    ui.ButtonSet.OK_CANCEL
  );

  if (response.getSelectedButton() !== ui.Button.OK) {
    return;
  }

  const baseUrl = normalizeBaseUrl_(response.getResponseText());
  PropertiesService.getScriptProperties().setProperty('FAMILY_LEDGER_BASE_URL', baseUrl);
  ui.alert('Saved API base URL: ' + baseUrl);
}

function setFamilyLedgerApiToken() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt(
    'Family Ledger API Token',
    'Paste the bearer token configured on the server.',
    ui.ButtonSet.OK_CANCEL
  );

  if (response.getSelectedButton() !== ui.Button.OK) {
    return;
  }

  const token = normalizeApiToken_(response.getResponseText());
  PropertiesService.getScriptProperties().setProperty('FAMILY_LEDGER_API_TOKEN', token);
  ui.alert('Saved API token.');
}

function showFamilyLedgerSettings() {
  const ui = SpreadsheetApp.getUi();
  const baseUrl = getFamilyLedgerBaseUrl_();
  const apiToken = getFamilyLedgerApiToken_();
  ui.alert(
    'Family Ledger Settings',
    'Base URL: ' + (baseUrl || '(not set)') + '\n' +
      'API token: ' + (apiToken ? maskToken_(apiToken) : '(not set)'),
    ui.ButtonSet.OK
  );
}

function testFamilyLedgerConnection() {
  const ui = SpreadsheetApp.getUi();
  const baseUrl = getFamilyLedgerBaseUrl_();
  const apiToken = getFamilyLedgerApiToken_();
  if (!baseUrl) {
    throw new Error('Missing FAMILY_LEDGER_BASE_URL. Run Set API Base URL first.');
  }
  if (!apiToken) {
    throw new Error('Missing FAMILY_LEDGER_API_TOKEN. Run Set API Token first.');
  }

  let healthMessage = 'not checked';
  let authMessage = 'not checked';

  try {
    const health = apiFetchJson_('get', '/healthz', undefined, { skipAuth: true });
    healthMessage = health.status === 'ok' ? 'ok' : 'unexpected response';
  } catch (error) {
    healthMessage = error.message;
  }

  if (healthMessage === 'ok') {
    try {
      apiFetchJson_('get', '/accounts?page_size=1');
      authMessage = 'ok';
    } catch (error) {
      authMessage = error.message;
    }
  }

  ui.alert(
    'Family Ledger Connection Test',
    'Health: ' + healthMessage + '\n' + 'Ledger auth: ' + authMessage,
    ui.ButtonSet.OK
  );
}

function syncFamilyLedgerAccounts() {
  const accounts = fetchFamilyLedgerPagedResource_('/accounts?page_size=100', 'accounts');
  accounts.sort(function(a, b) {
    return a.account_name.localeCompare(b.account_name);
  });

  const sheet = getOrCreateSheet_(FAMILY_LEDGER_SHEET_NAMES.accounts);
  const rows = accounts.map(function(account) {
    return [account.account_name, account.name];
  });

  writeSheet_(sheet, FAMILY_LEDGER_ACCOUNTS_HEADERS, rows);
  sheet.setFrozenRows(1);
}

function syncFamilyLedgerTransactions() {
  const transactions = fetchFamilyLedgerPagedResource_('/transactions?page_size=100', 'transactions');
  const accountNameLookup = loadAccountsFromApi_();
  const rows = [];

  transactions.forEach(function(transaction) {
    if (!isSimpleEditableTransaction_(transaction)) {
      return;
    }

    const sourcePosting = withPostingAccountNames_(transaction.postings[0], accountNameLookup);
    const categoryPosting = withPostingAccountNames_(transaction.postings[1], accountNameLookup);

    rows.push([
      transaction.name,
      transaction.transaction_date,
      transaction.payee || '',
      transaction.narration || '',
      sourcePosting.account_name || '',
      categoryPosting.account_name || '',
      categoryPosting.units.amount,
      categoryPosting.units.symbol,
      '',
      '',
      '',
      JSON.stringify(transaction),
    ]);
  });

  const sheet = getOrCreateSheet_(FAMILY_LEDGER_SHEET_NAMES.transactions);
  writeSheet_(sheet, FAMILY_LEDGER_TRANSACTION_HEADERS, rows);
  sheet.setFrozenRows(1);
  applyCategoryValidation_(sheet, rows.length);
  protectTransactionSheet_(sheet);
  const originalJsonColumn = FAMILY_LEDGER_TRANSACTION_HEADERS.indexOf('original_transaction_json') + 1;
  sheet.hideColumns(originalJsonColumn);
}

function pushActiveFamilyLedgerTransactionRow() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = spreadsheet.getActiveSheet();
  if (sheet.getName() !== FAMILY_LEDGER_SHEET_NAMES.transactions) {
    throw new Error('Select a row in the Transactions sheet before pushing.');
  }

  const activeRow = sheet.getActiveRange().getRow();
  if (activeRow <= 1) {
    throw new Error('Select a transaction data row before pushing.');
  }

  const rowValues = sheet
    .getRange(activeRow, 1, 1, FAMILY_LEDGER_TRANSACTION_HEADERS.length)
    .getValues()[0];
  const row = rowToObject_(FAMILY_LEDGER_TRANSACTION_HEADERS, rowValues);

  try {
    const payload = buildTransactionPatchPayload_(row, loadAccountNameMap_());
    apiFetchJson_('patch', '/' + row.transaction_name, {
      transaction: payload,
      update_mask: 'transaction_date,payee,narration,postings',
    });
    sheet.getRange(activeRow, 10).setValue('pushed');
    sheet.getRange(activeRow, 11).setValue('');
  } catch (error) {
    sheet.getRange(activeRow, 10).setValue('error');
    sheet.getRange(activeRow, 11).setValue(error.message);
    throw error;
  }
}

function buildTransactionPatchPayload_(row, accountNameMap) {
  const original = JSON.parse(row.original_transaction_json);
  if (!isSimpleEditableTransaction_(original)) {
    throw new Error('Only simple two-posting transactions are supported by this POC.');
  }

  const sourcePosting = original.postings[0];
  const categoryPosting = original.postings[1];
  const replacementPostings = buildReplacementCategoryPostings_(
    row,
    categoryPosting,
    accountNameMap
  );

  return {
    transaction_date: normalizeTransactionDate_(row.transaction_date),
    payee: emptyStringToNull_(row.payee),
    narration: emptyStringToNull_(row.narration),
    entity_metadata: original.entity_metadata || {},
    import_metadata: original.import_metadata || null,
    postings: [stripPostingForPatch_(sourcePosting)].concat(replacementPostings),
  };
}

function buildReplacementCategoryPostings_(row, categoryPosting, accountNameMap) {
  if (row.split_postings_json) {
    return buildSplitCategoryPostings_(row.split_postings_json, categoryPosting, accountNameMap);
  }

  const categoryAccountName = String(row.category_account_name || '').trim();
  if (!categoryAccountName) {
    throw new Error('category_account_name is required when split_postings_json is blank.');
  }

  return [
    {
      account: resolveAccountResourceName_(accountNameMap, categoryAccountName),
      units: {
        amount: String(categoryPosting.units.amount),
        symbol: categoryPosting.units.symbol,
      },
      cost: categoryPosting.cost || null,
      price: categoryPosting.price || null,
      entity_metadata: categoryPosting.entity_metadata || {},
    },
  ];
}

function buildSplitCategoryPostings_(splitJson, categoryPosting, accountNameMap) {
  let splitRows;
  try {
    splitRows = JSON.parse(splitJson);
  } catch {
    throw new Error('split_postings_json must be valid JSON.');
  }

  if (!Array.isArray(splitRows) || splitRows.length === 0) {
    throw new Error('split_postings_json must be a non-empty JSON array.');
  }

  const symbol = categoryPosting.units.symbol;
  const expectedAmount = normalizeDecimalString_(String(categoryPosting.units.amount));
  const splitAmounts = [];
  const postings = splitRows.map(function(splitRow) {
    const accountName = String(splitRow.account_name || '').trim();
    const amount = normalizeDecimalString_(String(splitRow.amount || ''));
    if (!accountName) {
      throw new Error('Each split posting requires account_name.');
    }
    splitAmounts.push(amount);
    return {
      account: resolveAccountResourceName_(accountNameMap, accountName),
      units: {
        amount: amount,
        symbol: symbol,
      },
      entity_metadata: {},
    };
  });

  const actualAmount = sumDecimalStrings_(splitAmounts);
  if (actualAmount !== expectedAmount) {
    throw new Error(
      'Split amounts must sum to ' + expectedAmount + ' ' + symbol + ', got ' + actualAmount + ' ' + symbol + '.'
    );
  }

  return postings;
}

function isSimpleEditableTransaction_(transaction) {
  return transaction && Array.isArray(transaction.postings) && transaction.postings.length === 2;
}

function loadAccountNameMap_() {
  const accountsSheet = getOrCreateSheet_(FAMILY_LEDGER_SHEET_NAMES.accounts);
  const lastRow = accountsSheet.getLastRow();
  const mapping = {};
  if (lastRow <= 1) {
    throw new Error('Accounts sheet is empty. Run Sync Accounts first.');
  }

  const rows = accountsSheet.getRange(2, 1, lastRow - 1, 2).getValues();
  rows.forEach(function(row) {
    if (row[0] && row[1]) {
      mapping[String(row[0])] = String(row[1]);
    }
  });
  return mapping;
}

function resolveAccountResourceName_(accountNameMap, accountName) {
  const resourceName = accountNameMap[accountName];
  if (!resourceName) {
    throw new Error('Unknown account_name: ' + accountName);
  }
  return resourceName;
}

function applyCategoryValidation_(sheet, rowCount) {
  if (rowCount === 0) {
    return;
  }

  const accountsSheet = getOrCreateSheet_(FAMILY_LEDGER_SHEET_NAMES.accounts);
  const lastRow = accountsSheet.getLastRow();
  if (lastRow <= 1) {
    return;
  }

  const rule = SpreadsheetApp.newDataValidation()
    .requireValueInRange(accountsSheet.getRange(2, 1, lastRow - 1, 1), true)
    .setAllowInvalid(false)
    .build();

  const categoryColumn = FAMILY_LEDGER_TRANSACTION_HEADERS.indexOf('category_account_name') + 1;
  sheet.getRange(2, categoryColumn, rowCount, 1).setDataValidation(rule);
}

function fetchFamilyLedgerPagedResource_(path, resourceKey) {
  let nextPath = path;
  const items = [];

  while (nextPath) {
    const response = apiFetchJson_('get', nextPath);
    const pageItems = response[resourceKey] || [];
    pageItems.forEach(function(item) {
      items.push(item);
    });
    nextPath = response.next_page_token
      ? pathWithUpdatedPageToken_(nextPath, response.next_page_token)
      : null;
  }

  return items;
}

function loadAccountsFromApi_() {
  const accounts = fetchFamilyLedgerPagedResourceWithoutDecoration_('/accounts?page_size=100', 'accounts');
  const lookup = {};
  accounts.forEach(function(account) {
    lookup[account.name] = account.account_name;
  });
  return lookup;
}

function fetchFamilyLedgerPagedResourceWithoutDecoration_(path, resourceKey) {
  let nextPath = path;
  const items = [];

  while (nextPath) {
    const response = apiFetchJson_('get', nextPath);
    const pageItems = response[resourceKey] || [];
    pageItems.forEach(function(item) {
      items.push(item);
    });
    nextPath = response.next_page_token
      ? pathWithUpdatedPageToken_(nextPath, response.next_page_token)
      : null;
  }

  return items;
}

function pathWithUpdatedPageToken_(path, pageToken) {
  const parts = path.split('?');
  const basePath = parts[0];
  const query = parts[1] || '';
  const filtered = query
    .split('&')
    .filter(function(part) {
      return part && part.indexOf('page_token=') !== 0;
    });
  filtered.push('page_token=' + encodeURIComponent(pageToken));
  return basePath + '?' + filtered.join('&');
}

function apiFetchJson_(method, path, payload, options) {
  options = options || {};
  const url = buildApiUrl_(path);
  const requestOptions = {
    method: method,
    contentType: 'application/json',
    muteHttpExceptions: true,
  };

  if (payload !== undefined) {
    requestOptions.payload = JSON.stringify(payload);
  }

  if (!options.skipAuth) {
    requestOptions.headers = {
      Authorization: 'Bearer ' + getRequiredFamilyLedgerApiToken_(),
    };
  }

  const response = UrlFetchApp.fetch(url, requestOptions);
  const statusCode = response.getResponseCode();
  const body = response.getContentText();

  if (statusCode >= 400) {
    throw buildApiError_(statusCode, body);
  }

  return body ? JSON.parse(body) : {};
}

function buildApiError_(statusCode, body) {
  if (!body) {
    return new Error('API request failed with status ' + statusCode + '.');
  }

  try {
    const parsed = JSON.parse(body);
    if (parsed.detail && parsed.detail.message) {
      return new Error(parsed.detail.code + ': ' + parsed.detail.message);
    }
  } catch {
    // Fall through to the raw body error below.
  }

  return new Error('API request failed with status ' + statusCode + ': ' + body);
}

function buildApiUrl_(path) {
  const baseUrl = getFamilyLedgerBaseUrl_();
  if (!baseUrl) {
    throw new Error('Missing FAMILY_LEDGER_BASE_URL script property.');
  }
  if (path.charAt(0) === '/') {
    return baseUrl + path;
  }
  return baseUrl + '/' + path;
}

function getFamilyLedgerBaseUrl_() {
  return PropertiesService.getScriptProperties().getProperty('FAMILY_LEDGER_BASE_URL');
}

function getFamilyLedgerApiToken_() {
  return PropertiesService.getScriptProperties().getProperty('FAMILY_LEDGER_API_TOKEN');
}

function getRequiredFamilyLedgerApiToken_() {
  const token = getFamilyLedgerApiToken_();
  if (!token) {
    throw new Error('Missing FAMILY_LEDGER_API_TOKEN. Run Set API Token first.');
  }
  return token;
}

function normalizeBaseUrl_(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    throw new Error('API base URL cannot be blank.');
  }
  return trimmed.replace(/\/+$/, '');
}

function normalizeApiToken_(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    throw new Error('API token cannot be blank.');
  }
  return trimmed;
}

function getOrCreateSheet_(sheetName) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(sheetName);
  }
  return sheet;
}

function writeSheet_(sheet, headers, rows) {
  sheet.clearContents();
  sheet.clearFormats();
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  }
}

function protectTransactionSheet_(sheet) {
  const existingProtections = sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE);
  existingProtections.forEach(function(protection) {
    protection.remove();
  });

  const protectedHeaders = [
    'transaction_name',
    'source_account_name',
    'amount',
    'symbol',
    'original_transaction_json',
  ];

  protectedHeaders.forEach(function(header) {
    const column = FAMILY_LEDGER_TRANSACTION_HEADERS.indexOf(header) + 1;
    if (column <= 0) {
      return;
    }

    const protection = sheet.getRange(1, column, Math.max(sheet.getMaxRows(), 1), 1).protect();
    protection.setDescription('Managed by Family Ledger sync');
    protection.setWarningOnly(true);
  });
}

function rowToObject_(headers, rowValues) {
  const result = {};
  headers.forEach(function(header, index) {
    result[header] = rowValues[index];
  });
  return result;
}

function withPostingAccountNames_(posting, accountNameLookup) {
  const clone = JSON.parse(JSON.stringify(posting));
  clone.account_name = accountNameLookup[posting.account] || posting.account;
  return clone;
}

function stripPostingForPatch_(posting) {
  return {
    account: posting.account,
    units: posting.units,
    cost: posting.cost || null,
    price: posting.price || null,
    entity_metadata: posting.entity_metadata || {},
  };
}

function emptyStringToNull_(value) {
  const text = String(value || '').trim();
  return text ? text : null;
}

function normalizeTransactionDate_(value) {
  if (Object.prototype.toString.call(value) === '[object Date]') {
    return Utilities.formatDate(value, 'UTC', 'yyyy-MM-dd');
  }
  return String(value);
}

function maskToken_(token) {
  if (token.length <= 8) {
    return '********';
  }
  return token.slice(0, 4) + '...' + token.slice(-4);
}

function normalizeDecimalString_(value) {
  const text = String(value || '').trim();
  if (!/^[-+]?\d+(\.\d+)?$/.test(text)) {
    throw new Error('Invalid decimal amount: ' + value);
  }

  let sign = '';
  let unsigned = text;
  if (unsigned.charAt(0) === '+' || unsigned.charAt(0) === '-') {
    sign = unsigned.charAt(0) === '-' ? '-' : '';
    unsigned = unsigned.slice(1);
  }

  const parts = unsigned.split('.');
  const integerPart = parts[0].replace(/^0+(?=\d)/, '') || '0';
  const fractionalPart = parts[1] ? parts[1].replace(/0+$/, '') : '';
  if (!fractionalPart) {
    return sign + integerPart;
  }
  return sign + integerPart + '.' + fractionalPart;
}

function sumDecimalStrings_(values) {
  const normalized = values.map(function(value) {
    return normalizeDecimalString_(value);
  });
  let scale = 0;
  normalized.forEach(function(value) {
    const parts = value.replace(/^[-+]/, '').split('.');
    const fractional = parts[1] || '';
    if (fractional.length > scale) {
      scale = fractional.length;
    }
  });

  let total = BigInt(0);
  normalized.forEach(function(value) {
    total += decimalStringToBigInt_(value, scale);
  });
  return bigIntToDecimalString_(total, scale);
}

function decimalStringToBigInt_(value, scale) {
  const normalized = normalizeDecimalString_(value);
  const negative = normalized.charAt(0) === '-';
  const unsigned = negative ? normalized.slice(1) : normalized;
  const parts = unsigned.split('.');
  const integerPart = parts[0];
  const fractionalPart = (parts[1] || '').padEnd(scale, '0');
  const digits = integerPart + fractionalPart;
  const amount = BigInt(digits || '0');
  return negative ? -amount : amount;
}

function bigIntToDecimalString_(value, scale) {
  const negative = value < 0;
  const absolute = negative ? -value : value;
  let digits = absolute.toString();
  while (digits.length <= scale) {
    digits = '0' + digits;
  }

  if (scale === 0) {
    return (negative ? '-' : '') + digits;
  }

  const integerPart = digits.slice(0, digits.length - scale) || '0';
  const fractionalPart = digits.slice(digits.length - scale).replace(/0+$/, '');
  if (!fractionalPart) {
    return (negative ? '-' : '') + integerPart;
  }
  return (negative ? '-' : '') + integerPart + '.' + fractionalPart;
}
