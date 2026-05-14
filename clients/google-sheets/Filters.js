function showQuickFilter() {
  const html = HtmlService.createHtmlOutputFromFile('FilterSidebar').setTitle('Quick Filter');
  SpreadsheetApp.getUi().showSidebar(html);
}

function getQuickFilterSidebarData() {
  const props = PropertiesService.getDocumentProperties();
  return {
    years: getTransactionFilterYears(),
    accountNames: getQuickFilterAccountNames(),
    from: props.getProperty('QUICK_FILTER_FROM') || '',
    to: props.getProperty('QUICK_FILTER_TO') || '',
    accountPrefix: props.getProperty('QUICK_FILTER_ACCOUNT_PREFIX') || '',
  };
}

function getTransactionFilterYears() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet()
    .getSheetByName(FAMILY_LEDGER_SHEET_NAMES.transactions);
  if (!sheet || sheet.getLastRow() <= 1) return [];
  const dateCol = getColumnIndex_(FAMILY_LEDGER_SHEET_REGISTRY.transactions, 'transaction_date');
  const values = sheet.getRange(2, dateCol, sheet.getLastRow() - 1, 1).getValues();
  const seen = {};
  values.forEach(function(row) {
    const v = row[0];
    if (v instanceof Date && !isNaN(v.getTime())) {
      seen[v.getFullYear()] = true;
    }
  });
  return Object.keys(seen).map(Number).sort(function(a, b) { return b - a; });
}

function getQuickFilterAccountNames() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet()
    .getSheetByName(FAMILY_LEDGER_SHEET_NAMES.accounts);
  if (!sheet || sheet.getLastRow() <= 1) return [];
  const nameCol = getColumnIndex_(FAMILY_LEDGER_SHEET_REGISTRY.accounts, 'account_name');
  const values = sheet.getRange(2, nameCol, sheet.getLastRow() - 1, 1).getValues();
  return values.map(function(row) { return row[0]; })
    .filter(Boolean)
    .sort();
}

function ensureTransactionSheetFilter_(sheet) {
  const sheetConfig = FAMILY_LEDGER_SHEET_REGISTRY.transactions;
  ensureSheetCapacityForConfig_(sheet, sheetConfig);
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return;
  const existing = sheet.getFilter();
  const savedCriteriaByHeader = snapshotSheetFilterCriteriaByHeader_(sheet, sheetConfig, existing);
  if (existing) {
    existing.remove();
  }
  const filter = sheet.getRange(1, 1, lastRow, sheetConfig.headers.length).createFilter();
  restoreSheetFilterCriteriaByHeader_(filter, sheetConfig, savedCriteriaByHeader);
  reapplyPersistedQuickFilters_();
}

function ensureBalancesSheetFilter_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return;
  const existing = sheet.getFilter();
  if (existing) existing.remove();
  sheet.getRange(1, 1, lastRow, FAMILY_LEDGER_SHEET_REGISTRY.balances.headers.length).createFilter();
}

function ensureAccountsSheetFilter_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return;
  const existing = sheet.getFilter();
  if (existing) existing.remove();
  sheet.getRange(1, 1, lastRow, FAMILY_LEDGER_SHEET_REGISTRY.accounts.headers.length).createFilter();
}

function snapshotSheetFilterCriteriaByHeader_(sheet, sheetConfig, filter) {
  const savedCriteriaByHeader = {};
  if (!filter) {
    return savedCriteriaByHeader;
  }

  const filterColumnCount = getFilterColumnCount_(filter);
  const headerRowValues = readSheetHeaderRowValues_(sheet, sheetConfig, filterColumnCount);
  for (let index = 0; index < filterColumnCount; index += 1) {
    const header = String(headerRowValues[index] || '').trim();
    if (!header) {
      continue;
    }
    const criteria = filter.getColumnFilterCriteria(index + 1);
    if (criteria) {
      savedCriteriaByHeader[header] = criteria;
    }
  }

  return savedCriteriaByHeader;
}

function restoreSheetFilterCriteriaByHeader_(filter, sheetConfig, criteriaByHeader) {
  Object.keys(criteriaByHeader).forEach(function(header) {
    filter.setColumnFilterCriteria(getColumnIndex_(sheetConfig, header), criteriaByHeader[header]);
  });
}

function getFilterColumnCount_(filter) {
  if (!filter || !filter.getRange) {
    return 0;
  }
  const range = filter.getRange();
  if (!range || !range.getNumColumns) {
    return 0;
  }
  return range.getNumColumns();
}

function readSheetHeaderRowValues_(sheet, sheetConfig, columnCount) {
  const maxColumnCount = Math.min(columnCount, sheetConfig.headers.length);
  if (maxColumnCount <= 0) {
    return [];
  }
  return sheet.getRange(1, 1, 1, maxColumnCount).getValues()[0];
}

function reapplyPersistedQuickFilters_() {
  const props = PropertiesService.getDocumentProperties();
  const from = props.getProperty('QUICK_FILTER_FROM') || '';
  const to = props.getProperty('QUICK_FILTER_TO') || '';
  const accountPrefix = props.getProperty('QUICK_FILTER_ACCOUNT_PREFIX') || '';

  if (from && to) {
    applyQuickDateFilter(from, to);
  }
  if (accountPrefix) {
    applyQuickAccountFilter(accountPrefix);
  }
}

function buildQuickFilterDateFormula_(sheetConfig, header, from, to) {
  const col = getColumnLetter_(sheetConfig, header);
  const fromKey = parseInt(from.slice(0, 4), 10) * 100 + parseInt(from.slice(5), 10);
  const toKey   = parseInt(to.slice(0, 4),   10) * 100 + parseInt(to.slice(5),   10);
  const expr = 'YEAR(' + col + '2)*100+MONTH(' + col + '2)';
  return '=AND(' + expr + '>=' + fromKey + ',' + expr + '<=' + toKey + ')';
}

function buildQuickFilterAccountFormula_(sheetConfig, accountHeaders, prefix) {
  if (prefix === '__blank__') {
    if (accountHeaders.length < 2) return null;
    return '=' + getColumnLetter_(sheetConfig, accountHeaders[1]) + '2=""';
  }
  const cols = accountHeaders.map(function(h) { return getColumnLetter_(sheetConfig, h); });
  if (prefix.endsWith(']')) {
    const n = prefix.length + 1;
    const q = '"' + prefix + ' "';
    return '=OR(' + cols.map(function(c) { return 'LEFT(' + c + '2,' + n + ')=' + q; }).join(',') + ')';
  }
  const n  = prefix.length + 3;
  const eq = '"' + prefix + '"';
  const pq = '"' + prefix + ' - "';
  const parts = [];
  cols.forEach(function(c) {
    parts.push(c + '2=' + eq);
    parts.push('LEFT(' + c + '2,' + n + ')=' + pq);
  });
  return '=OR(' + parts.join(',') + ')';
}

function applyQuickFilterCriteria_(sheet, sheetConfig, header, formula) {
  if (!sheet || !formula) return;
  let filter = sheet.getFilter();
  if (!filter) {
    const lastRow = sheet.getLastRow();
    if (lastRow <= 1) return;
    filter = sheet.getRange(1, 1, lastRow, sheetConfig.headers.length).createFilter();
  }
  filter.setColumnFilterCriteria(
    getColumnIndex_(sheetConfig, header),
    SpreadsheetApp.newFilterCriteria().whenFormulaSatisfied(formula).build()
  );
}

function removeQuickFilterCriteria_(sheet, sheetConfig, header) {
  if (!sheet) return;
  const filter = sheet.getFilter();
  if (filter) filter.removeColumnFilterCriteria(getColumnIndex_(sheetConfig, header));
}

function applyQuickDateFilter(from, to) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  applyQuickFilterCriteria_(
    ss.getSheetByName(FAMILY_LEDGER_SHEET_NAMES.transactions),
    FAMILY_LEDGER_SHEET_REGISTRY.transactions, 'transaction_date',
    buildQuickFilterDateFormula_(FAMILY_LEDGER_SHEET_REGISTRY.transactions, 'transaction_date', from, to)
  );
  applyQuickFilterCriteria_(
    ss.getSheetByName(FAMILY_LEDGER_SHEET_NAMES.balances),
    FAMILY_LEDGER_SHEET_REGISTRY.balances, 'assertion_date',
    buildQuickFilterDateFormula_(FAMILY_LEDGER_SHEET_REGISTRY.balances, 'assertion_date', from, to)
  );
  const props = PropertiesService.getDocumentProperties();
  props.setProperty('QUICK_FILTER_FROM', from);
  props.setProperty('QUICK_FILTER_TO', to);
}

function clearQuickDateFilter() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  removeQuickFilterCriteria_(
    ss.getSheetByName(FAMILY_LEDGER_SHEET_NAMES.transactions),
    FAMILY_LEDGER_SHEET_REGISTRY.transactions, 'transaction_date'
  );
  removeQuickFilterCriteria_(
    ss.getSheetByName(FAMILY_LEDGER_SHEET_NAMES.balances),
    FAMILY_LEDGER_SHEET_REGISTRY.balances, 'assertion_date'
  );
  const props = PropertiesService.getDocumentProperties();
  props.deleteProperty('QUICK_FILTER_FROM');
  props.deleteProperty('QUICK_FILTER_TO');
}

function applyQuickAccountFilter(prefix) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  applyQuickFilterCriteria_(
    ss.getSheetByName(FAMILY_LEDGER_SHEET_NAMES.transactions),
    FAMILY_LEDGER_SHEET_REGISTRY.transactions, 'source_account_name',
    buildQuickFilterAccountFormula_(FAMILY_LEDGER_SHEET_REGISTRY.transactions,
      ['source_account_name', 'destination_account_name'], prefix)
  );
  applyQuickFilterCriteria_(
    ss.getSheetByName(FAMILY_LEDGER_SHEET_NAMES.balances),
    FAMILY_LEDGER_SHEET_REGISTRY.balances, 'account',
    buildQuickFilterAccountFormula_(FAMILY_LEDGER_SHEET_REGISTRY.balances, ['account'], prefix)
  );
  applyQuickFilterCriteria_(
    ss.getSheetByName(FAMILY_LEDGER_SHEET_NAMES.accounts),
    FAMILY_LEDGER_SHEET_REGISTRY.accounts, 'account_name',
    buildQuickFilterAccountFormula_(FAMILY_LEDGER_SHEET_REGISTRY.accounts, ['account_name'], prefix)
  );
  PropertiesService.getDocumentProperties().setProperty('QUICK_FILTER_ACCOUNT_PREFIX', prefix);
}

function clearQuickAccountFilter() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  removeQuickFilterCriteria_(
    ss.getSheetByName(FAMILY_LEDGER_SHEET_NAMES.transactions),
    FAMILY_LEDGER_SHEET_REGISTRY.transactions, 'source_account_name'
  );
  removeQuickFilterCriteria_(
    ss.getSheetByName(FAMILY_LEDGER_SHEET_NAMES.balances),
    FAMILY_LEDGER_SHEET_REGISTRY.balances, 'account'
  );
  removeQuickFilterCriteria_(
    ss.getSheetByName(FAMILY_LEDGER_SHEET_NAMES.accounts),
    FAMILY_LEDGER_SHEET_REGISTRY.accounts, 'account_name'
  );
  PropertiesService.getDocumentProperties().deleteProperty('QUICK_FILTER_ACCOUNT_PREFIX');
}

function clearQuickFilter() {
  clearQuickDateFilter();
  clearQuickAccountFilter();
  removeQuickFilterCriteria_(
    SpreadsheetApp.getActiveSpreadsheet().getSheetByName(FAMILY_LEDGER_SHEET_NAMES.transactions),
    FAMILY_LEDGER_SHEET_REGISTRY.transactions, 'destination_account_name'
  );
}
