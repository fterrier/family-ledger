// Requires the Google Sheets Advanced Service to be enabled:
// In the Apps Script editor: Extensions > Apps Script > Services > Google Sheets API (v4)
// Also enable "Google Sheets API" in the Google Cloud Console project linked to this script.

function showCreateReportDialog() {
  const html = HtmlService.createTemplateFromFile('CreateReportDialog').evaluate()
    .setWidth(420)
    .setHeight(460);
  SpreadsheetApp.getUi().showModalDialog(html, 'Quick Create Report');
}

function getReportDialogData() {
  return {
    reportAccountNames: getQuickFilterAccountNames().filter(isReportAccount_),
  };
}

function createExpenseReport(config) {
  if (!config || !config.accountNames || !config.accountNames.length) {
    throw new Error('At least one account must be selected.');
  }
  config.accountNames.forEach(function(name) {
    if (!isReportAccount_(name)) {
      throw new Error(
        'Only expense (' + FAMILY_LEDGER_ACCOUNT_ROOT_MARKERS.Expenses +
        ') and income (' + FAMILY_LEDGER_ACCOUNT_ROOT_MARKERS.Income +
        ') accounts can be selected.'
      );
    }
  });

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const txnSheet = ss.getSheetByName(FAMILY_LEDGER_SHEET_NAMES.transactions);
  if (!txnSheet) {
    throw new Error('Transactions sheet not found. Run Sync Ledger first.');
  }

  const txnRows = readTxnRows_(txnSheet, ['transaction_date', 'source_account_name', 'destination_account_name']);
  const warnings = scanSourceWarnings_(txnRows, config.accountNames);

  const destSeen = {};
  const visibleAccountNames = [];
  txnRows.forEach(function(row) {
    const dest = String(row.destination_account_name || '');
    config.accountNames.forEach(function(name) {
      if (dest && !destSeen[dest] && matchesAccountPrefix_(dest, name)) {
        destSeen[dest] = true;
        visibleAccountNames.push(dest);
      }
    });
  });

  if (!getQuickAddDefaultSymbol_()) {
    warnings.push(
      'No default currency is set in Sheet Settings. Report values will be blank. ' +
      'Set a default currency, re-run Sync Ledger, then recreate this report.'
    );
  }

  const accountLabel = config.accountNames
    .map(function(n) { return n.replace(/^\[\w+\]\s*/, ''); })
    .join(', ');
  const baseSheetNameFull = 'Report (' + accountLabel + ')';
  // Google Sheets rejects names over 100 chars; reserve space for ' (n)' uniquifier.
  const baseSheetName = baseSheetNameFull.length <= 94 ? baseSheetNameFull : baseSheetNameFull.slice(0, 93) + '…';
  const reportSheetName = findUniqueReportSheetName_(ss, baseSheetName);
  const reportSheet = ss.insertSheet(reportSheetName, ss.getSheets().length);

  createNativePivotTable_(txnSheet, reportSheet, visibleAccountNames, ss.getId());

  return { warnings: warnings, sheetName: reportSheetName };
}

function isReportAccount_(name) {
  const marker = name.split(' ')[0];
  return marker === FAMILY_LEDGER_ACCOUNT_ROOT_MARKERS.Expenses ||
         marker === FAMILY_LEDGER_ACCOUNT_ROOT_MARKERS.Income;
}

function matchesAccountPrefix_(name, prefix) {
  return name === prefix || name.startsWith(prefix + ' - ');
}

function findUniqueReportSheetName_(ss, baseName) {
  if (!ss.getSheetByName(baseName)) return baseName;
  let n = 2;
  while (ss.getSheetByName(baseName + ' (' + n + ')')) {
    n += 1;
  }
  return baseName + ' (' + n + ')';
}

function checkSourceAccountWarnings_(displayName) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const txnSheet = ss.getSheetByName(FAMILY_LEDGER_SHEET_NAMES.transactions);
  if (!txnSheet) return [];
  const rows = readTxnRows_(txnSheet, ['transaction_date', 'source_account_name']);
  return scanSourceWarnings_(rows, displayName);
}

function readTxnRows_(txnSheet, columns) {
  if (txnSheet.getLastRow() <= 1) return [];
  const txnConfig = FAMILY_LEDGER_SHEET_REGISTRY.transactions;
  const count = txnSheet.getLastRow() - 1;
  return managedSheet_(txnSheet, txnConfig).getRows({ start: 2, count: count }, columns);
}

function scanSourceWarnings_(rows, prefixes) {
  const prefixList = Array.isArray(prefixes) ? prefixes : [prefixes];
  const warningsByAccount = {};
  rows.forEach(function(row) {
    const src = String(row.source_account_name || '');
    if (!src || !prefixList.some(function(p) { return matchesAccountPrefix_(src, p); })) return;
    if (!warningsByAccount[src]) warningsByAccount[src] = [];
    if (warningsByAccount[src].length < 3) {
      const dateStr = normalizeEntityDate_(row.transaction_date);
      if (dateStr) warningsByAccount[src].push(dateStr.slice(0, 10));
    }
  });
  const result = [];
  Object.keys(warningsByAccount).sort().forEach(function(acct) {
    result.push('Account "' + acct + '" appears as source account on: ' + warningsByAccount[acct].join(', '));
  });
  return result;
}

function createNativePivotTable_(txnSheet, reportSheet, visibleAccountNames, spreadsheetId) {
  const txnConfig = FAMILY_LEDGER_SHEET_REGISTRY.transactions;
  const destOffset = txnConfig.columns.destination_account_name.index;
  const dateOffset = txnConfig.columns.transaction_date.index;
  const amtOffset = txnConfig.columns.amount_in_default_currency.index;
  const totalColumns = txnConfig.headers.length;

  const levelRows = txnConfig.headers
    .filter(function(h) { return /^dest_level_\d+$/.test(h); })
    .map(function(h) {
      return { sourceColumnOffset: txnConfig.columns[h].index, showTotals: true, sortOrder: 'ASCENDING' };
    });

  Sheets.Spreadsheets.batchUpdate({
    requests: [{
      updateCells: {
        rows: [{
          values: [{
            pivotTable: {
              source: {
                sheetId: txnSheet.getSheetId(),
                startRowIndex: 0,
                endRowIndex: txnSheet.getLastRow(),
                startColumnIndex: 0,
                endColumnIndex: totalColumns,
              },
              rows: levelRows,
              columns: [{
                sourceColumnOffset: dateOffset,
                showTotals: true,
                sortOrder: 'ASCENDING',
                groupRule: {
                  dateTimeRule: { type: 'YEAR' },
                },
              }],
              values: [{
                summarizeFunction: 'SUM',
                sourceColumnOffset: amtOffset,
                name: 'Amount',
              }],
              filterSpecs: [{
                columnOffsetIndex: destOffset,
                filterCriteria: {
                  visibleValues: visibleAccountNames,
                },
              }],
            },
          }],
        }],
        start: {
          sheetId: reportSheet.getSheetId(),
          rowIndex: 0,
          columnIndex: 0,
        },
        fields: 'pivotTable',
      },
    }],
  }, spreadsheetId);
}
