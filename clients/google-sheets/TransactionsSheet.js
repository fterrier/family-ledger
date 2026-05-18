// Thin wrapper — delegates to scanEntityRows_ in Entity.js.
// Renames entityName → transactionName for backward compatibility with callers
// in TransactionEdits.js that have not yet been migrated to Phase 2.
function findTransactionRowNumbersFromAnchor_(sheet, anchorRow) {
  const { span, entityName, rows } = scanEntityRows_(Transaction, sheet, anchorRow);
  return { span: span, transactionName: entityName, rows: rows };
}

/**
 * Replaces a contiguous block of transaction rows with new content.
 * span must be contiguous (guaranteed by findTransactionRowNumbersFromAnchor_).
 * Pass an empty replacementRows array to delete the block entirely.
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {{start: number, count: number}} span - Existing row span.
 * @param {Object[]} replacementRows - Replacement row objects.
 */
function replaceTransactionRowsInSheet_(sheet, span, replacementRows) {
  const targetSpan = resizeContiguousRows_(sheet, span, replacementRows.length);
  if (targetSpan.count === 0) return;
  managedSheet_(sheet, FAMILY_LEDGER_SHEET_REGISTRY.transactions).setRows(targetSpan, replacementRows);
  applyAccountValidationToSpan_(sheet, targetSpan);
}


function ensureTransactionIssueFormulas_(sheet, span) {
  managedSheet_(sheet, FAMILY_LEDGER_SHEET_REGISTRY.transactions).setColumnFormulas(span, 'issues', buildIssueLookupFormula_);
}

/**
 * Scans the transactions sheet and returns one anchor object per transaction,
 * in sheet order. Used by findInsertionRowForTransactionDate_ to locate the
 * correct insertion point for new transactions.
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @return {{transactionName: string, span: {start: number, count: number}, transactionDate: string}[]}
 */
function buildTransactionGroupAnchors_(sheet) {
  const lastRow = sheet.getLastRow();
  const anchors = [];
  if (lastRow <= 1) return anchors;
  const txConfig = FAMILY_LEDGER_SHEET_REGISTRY.transactions;
  const rows = managedSheet_(sheet, txConfig).getRows({ start: 2, count: lastRow - 1 }, ['resource_name', 'transaction_date']);
  let current = null;
  rows.forEach(function(row, index) {
    const transactionName = String(row.resource_name || '').trim();
    if (!transactionName) return;
    const rowNumber = index + 2;
    const transactionDate = normalizeTransactionDate_(row.transaction_date);
    if (!current || current.transactionName !== transactionName) {
      if (current) anchors.push(current);
      current = { transactionName: transactionName, span: { start: rowNumber, count: 1 }, transactionDate: transactionDate };
      return;
    }
    current.span.count = rowNumber - current.span.start + 1;
  });
  if (current) anchors.push(current);
  return anchors;
}

function findInsertionRowForTransactionDate_(sheet, transactionDate) {
  const normalizedDate = normalizeTransactionDate_(transactionDate);
  const anchors = buildTransactionGroupAnchors_(sheet);
  for (let index = 0; index < anchors.length; index += 1) {
    if (anchors[index].transactionDate > normalizedDate) {
      return anchors[index].span.start;
    }
  }
  const lastAnchor = anchors[anchors.length - 1];
  return lastAnchor ? lastAnchor.span.start + lastAnchor.span.count : 2;
}

/**
 * Applies a flattened API response to the transactions sheet after a save.
 * Handles three cases:
 *   - New transaction (existingSpan=null): inserts rows at the date-sorted position.
 *   - Same posting count: writes replacement data in place, no structural change.
 *   - Count changed: uses resizeContiguousRows_ to insert/delete, then writes.
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {{start: number, count: number}|null} existingSpan - Existing span for PATCH; null for POST.
 * @param {Object[]} replacementRows - Flattened row objects with status/split_off_amount stamped.
 * @return {{start: number, count: number}} Final span where data was written.
 */
function applyTransactionResponseToSheet_(sheet, existingSpan, replacementRows) {
  let targetSpan;
  if (!existingSpan) {
    // New transaction: insert rows at date-sorted position
    const insertionRow = findInsertionRowForTransactionDate_(sheet, replacementRows[0].transaction_date);
    targetSpan = resizeContiguousRows_(sheet, { start: insertionRow, count: 0 }, replacementRows.length);
  } else if (existingSpan.count === replacementRows.length) {
    // Same count: write in place without structural changes
    targetSpan = existingSpan;
  } else {
    // Count changed: adjust row count then write (transactions are always contiguous)
    targetSpan = resizeContiguousRows_(sheet, existingSpan, replacementRows.length);
  }

  managedSheet_(sheet, FAMILY_LEDGER_SHEET_REGISTRY.transactions).setRows(targetSpan, replacementRows);
  applyAccountValidationToSpan_(sheet, targetSpan);
  ensureTransactionIssueFormulas_(sheet, targetSpan);
  return targetSpan;
}
