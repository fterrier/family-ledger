function showQuickFilter() {
  const html = HtmlService.createHtmlOutputFromFile('FilterSidebar').setTitle('Quick Filter');
  SpreadsheetApp.getUi().showSidebar(html);
}

function getQuickFilterSidebarData() {
  const props = PropertiesService.getDocumentProperties();
  return {
    years: getTransactionFilterYears(),
    accountNames: getTransactionAccountNames(),
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
  reapplyPersistedTransactionQuickFilters_();
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

function reapplyPersistedTransactionQuickFilters_() {
  const props = PropertiesService.getDocumentProperties();
  const from = props.getProperty('QUICK_FILTER_FROM') || '';
  const to = props.getProperty('QUICK_FILTER_TO') || '';
  const accountPrefix = props.getProperty('QUICK_FILTER_ACCOUNT_PREFIX') || '';

  if (from && to) {
    applyTransactionQuickFilter(from, to);
  }
  if (accountPrefix) {
    applyTransactionAccountFilter(accountPrefix);
  }
}

function applyTransactionQuickFilter(from, to) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet()
    .getSheetByName(FAMILY_LEDGER_SHEET_NAMES.transactions);
  if (!sheet) throw new Error('Transactions sheet not found.');
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return;
  let filter = sheet.getFilter();
  if (!filter) {
    filter = sheet.getRange(1, 1, lastRow, FAMILY_LEDGER_SHEET_REGISTRY.transactions.headers.length).createFilter();
  }
  const dateCol = getColumnIndex_(FAMILY_LEDGER_SHEET_REGISTRY.transactions, 'transaction_date');
  const col = getColumnLetter_(FAMILY_LEDGER_SHEET_REGISTRY.transactions, 'transaction_date');
  const fromParts = from.split('-');
  const toParts = to.split('-');
  const fromKey = parseInt(fromParts[0], 10) * 100 + parseInt(fromParts[1], 10);
  const toKey = parseInt(toParts[0], 10) * 100 + parseInt(toParts[1], 10);
  const expr = 'YEAR(' + col + '2)*100+MONTH(' + col + '2)';
  const formula = '=AND(' + expr + '>=' + fromKey + ',' + expr + '<=' + toKey + ')';
  filter.setColumnFilterCriteria(
    dateCol,
    SpreadsheetApp.newFilterCriteria().whenFormulaSatisfied(formula).build()
  );
  const props = PropertiesService.getDocumentProperties();
  props.setProperty('QUICK_FILTER_FROM', from);
  props.setProperty('QUICK_FILTER_TO', to);
}

function clearTransactionDateFilter() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet()
    .getSheetByName(FAMILY_LEDGER_SHEET_NAMES.transactions);
  if (!sheet) throw new Error('Transactions sheet not found.');
  const filter = sheet.getFilter();
  if (filter) {
    filter.removeColumnFilterCriteria(getColumnIndex_(FAMILY_LEDGER_SHEET_REGISTRY.transactions, 'transaction_date'));
  }
  const props = PropertiesService.getDocumentProperties();
  props.deleteProperty('QUICK_FILTER_FROM');
  props.deleteProperty('QUICK_FILTER_TO');
}

function clearTransactionQuickFilter() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet()
    .getSheetByName(FAMILY_LEDGER_SHEET_NAMES.transactions);
  if (!sheet) throw new Error('Transactions sheet not found.');
  const filter = sheet.getFilter();
  if (filter) {
    filter.removeColumnFilterCriteria(getColumnIndex_(FAMILY_LEDGER_SHEET_REGISTRY.transactions, 'transaction_date'));
    filter.removeColumnFilterCriteria(getColumnIndex_(FAMILY_LEDGER_SHEET_REGISTRY.transactions, 'source_account_name'));
    filter.removeColumnFilterCriteria(getColumnIndex_(FAMILY_LEDGER_SHEET_REGISTRY.transactions, 'destination_account_name'));
  }
  const props = PropertiesService.getDocumentProperties();
  props.deleteProperty('QUICK_FILTER_FROM');
  props.deleteProperty('QUICK_FILTER_TO');
  props.deleteProperty('QUICK_FILTER_ACCOUNT_PREFIX');
}

function applyTransactionAccountFilter(prefix) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet()
    .getSheetByName(FAMILY_LEDGER_SHEET_NAMES.transactions);
  if (!sheet) throw new Error('Transactions sheet not found.');
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return;
  let filter = sheet.getFilter();
  if (!filter) {
    filter = sheet.getRange(1, 1, lastRow, FAMILY_LEDGER_SHEET_REGISTRY.transactions.headers.length).createFilter();
  }
  const srcCol = getColumnIndex_(FAMILY_LEDGER_SHEET_REGISTRY.transactions, 'source_account_name');
  const dstCol = getColumnIndex_(FAMILY_LEDGER_SHEET_REGISTRY.transactions, 'destination_account_name');
  const s = getColumnLetter_(FAMILY_LEDGER_SHEET_REGISTRY.transactions, 'source_account_name');
  const d = getColumnLetter_(FAMILY_LEDGER_SHEET_REGISTRY.transactions, 'destination_account_name');
  let formula;
  if (prefix === '__blank__') {
    formula = '=' + d + '2=""';
  } else if (prefix.endsWith(']')) {
    const n = prefix.length + 1;
    const q = '"' + prefix + ' "';
    formula = '=OR(LEFT(' + s + '2,' + n + ')=' + q + ',LEFT(' + d + '2,' + n + ')=' + q + ')';
  } else {
    const n = prefix.length + 3;
    const eq = '"' + prefix + '"';
    const pq = '"' + prefix + ' - "';
    formula = '=OR(' + s + '2=' + eq + ',LEFT(' + s + '2,' + n + ')=' + pq + ',' + d + '2=' + eq + ',LEFT(' + d + '2,' + n + ')=' + pq + ')';
  }
  filter.setColumnFilterCriteria(
    srcCol,
    SpreadsheetApp.newFilterCriteria().whenFormulaSatisfied(formula).build()
  );
  PropertiesService.getDocumentProperties().setProperty('QUICK_FILTER_ACCOUNT_PREFIX', prefix);
}

function clearTransactionAccountFilter() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet()
    .getSheetByName(FAMILY_LEDGER_SHEET_NAMES.transactions);
  if (!sheet) throw new Error('Transactions sheet not found.');
  const filter = sheet.getFilter();
  if (filter) filter.removeColumnFilterCriteria(getColumnIndex_(FAMILY_LEDGER_SHEET_REGISTRY.transactions, 'source_account_name'));
  PropertiesService.getDocumentProperties().deleteProperty('QUICK_FILTER_ACCOUNT_PREFIX');
}
