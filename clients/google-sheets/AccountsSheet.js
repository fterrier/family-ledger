function buildAccountDisplayEntries_(accounts) {
  return accounts.map(function(account) {
    return {
      account_name: account.account_name,
      resource_name: account.name,
      display_name: formatAccountDisplayName_(account.account_name),
    };
  });
}

function formatAccountDisplayName_(accountName) {
  const canonical = String(accountName || '').trim();
  if (!canonical) {
    return canonical;
  }
  const segments = canonical.split(':');
  const root = segments[0];
  const marker = FAMILY_LEDGER_ACCOUNT_ROOT_MARKERS[root] || '[?]';
  const tail = segments.length > 1 ? segments.slice(1) : segments;
  return marker + ' ' + tail.join(' - ');
}

function loadAccountOptions_() {
  return readAccountSheetEntries_()
    .filter(function(entry) { return entry.resourceName && entry.displayName; })
    .map(function(entry) { return { resource_name: entry.resourceName, display_name: entry.displayName }; })
    .sort(function(a, b) { return a.display_name.localeCompare(b.display_name); });
}

function readAccountSheetEntries_() {
  const accountsSheet = getOrCreateSheet_(FAMILY_LEDGER_SHEET_NAMES.accounts);
  const lastRow = accountsSheet.getLastRow();
  if (lastRow <= 1) {
    throw new Error('Accounts sheet is empty. Run Sync Ledger first.');
  }

  const accConfig = FAMILY_LEDGER_SHEET_REGISTRY.accounts;
  return managedSheet_(accountsSheet, accConfig)
    .getRows({ start: 2, count: lastRow - 1 }, ['resource_name', 'account_name'])
    .map(function(row) {
      return {
        resourceName: row.resource_name ? String(row.resource_name) : '',
        displayName: row.account_name ? String(row.account_name) : '',
      };
    });
}


function ensureAccountIssueFormulas_(sheet, span) {
  managedSheet_(sheet, FAMILY_LEDGER_SHEET_REGISTRY.accounts).setColumnFormulas(span, 'issues', buildIssueLookupFormula_);
}

function buildAccountValidationRule_() {
  const accountsSheet = getOrCreateSheet_(FAMILY_LEDGER_SHEET_NAMES.accounts);
  const lastRow = accountsSheet.getLastRow();
  if (lastRow <= 1) return null;
  const accConfig = FAMILY_LEDGER_SHEET_REGISTRY.accounts;
  return SpreadsheetApp.newDataValidation()
    .requireValueInRange(managedSheet_(accountsSheet, accConfig).getColumnRange({ start: 2, count: lastRow - 1 }, 'account_name'), true)
    .setAllowInvalid(false)
    .build();
}

function applyAccountValidation_(sheet, span) {
  if (span.count === 0) return;
  applyAccountValidationToSpan_(sheet, span);
}


/**
 * Applies account dropdown validation to a contiguous span of transaction rows.
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {{start: number, count: number}} span - Contiguous row span.
 */
function applyAccountValidationToSpan_(sheet, span) {
  if (span.count === 0) return;
  const txConfig = FAMILY_LEDGER_SHEET_REGISTRY.transactions;
  // TODO: Improve account UX beyond dropdown validation, especially for large account lists.
  managedSheet_(sheet, txConfig).clearColumnValidations(span, ['source_account_name', 'destination_account_name']);
  const rule = buildAccountValidationRule_();
  if (!rule) return;
  managedSheet_(sheet, txConfig).setColumnValidation(span, 'destination_account_name', rule);
}

function refreshTransactionAccountValidation_(sheet) {
  applyAccountValidation_(sheet, { start: 2, count: Math.max((sheet.getLastRow ? sheet.getLastRow() : 1) - 1, 0) });
}
