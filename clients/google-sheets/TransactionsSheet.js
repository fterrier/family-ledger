/**
 * Converts a transaction API object into one or more sheet row objects, one per
 * destination posting. Returns null for unsupported transaction shapes (multiple
 * symbols, multiple negative legs without a balance-sheet source, etc.).
 *
 * @param {Object} transaction - Raw API transaction object.
 * @param {Object} accountResourceToDisplayName - Map of resource_name → display_name.
 * @return {Object[]|null} Row objects ready for sheet write, or null if unsupported.
 */
function flattenTransactionForSheet_(transaction, accountResourceToDisplayName) {
  const shape = classifySupportedTransaction_(transaction, accountResourceToDisplayName);
  if (shape === null) {
    return null;
  }

  const transactionNarration = String(transaction.narration || '');

  if (shape.sourceIndex === null) {
    return [{
      resource_name: transaction.name,
      narration_source: 'txn',
      transaction_date: transaction.transaction_date,
      payee: transaction.payee || '',
      narration: transactionNarration,
      source_account_name: '',
      destination_account_name: '',
      amount: '',
      split_off_amount: '',
      symbol: '',
      status: '',
      issues: '',
      last_error: '',
    }];
  }

  const sourcePosting = transaction.postings[shape.sourceIndex];
  const sourceAccountName = accountResourceToDisplayName[sourcePosting.account] || sourcePosting.account;
  const sourcePostingNarration = String(sourcePosting.narration || '');
  const issues = '';

  if (shape.destinationIndexes.length === 0) {
    const postingNarration = sourcePostingNarration;
    return [{
      resource_name: transaction.name,
      narration_source: postingNarration ? 'post' : 'txn',
      transaction_date: transaction.transaction_date,
      payee: transaction.payee || '',
      narration: effectiveSheetNarration_(transactionNarration, postingNarration),
      source_account_name: sourceAccountName,
      destination_account_name: '',
      amount: -parseFloat(sourcePosting.units.amount),
      split_off_amount: '',
      symbol: sourcePosting.units.symbol,
      status: '',
      issues: issues,
      last_error: '',
    }];
  }

  return shape.destinationIndexes.map(function(destinationIndex) {
    const posting = transaction.postings[destinationIndex];
    const postingNarration = String(posting.narration || '');
    return {
      resource_name: transaction.name,
      narration_source: postingNarration ? 'post' : 'txn',
      transaction_date: transaction.transaction_date,
      payee: transaction.payee || '',
      narration: effectiveSheetNarration_(transactionNarration, postingNarration),
      source_account_name: sourceAccountName,
      destination_account_name: accountResourceToDisplayName[posting.account] || posting.account,
      amount: parseFloat(posting.units.amount),
      split_off_amount: '',
      symbol: posting.units.symbol,
      status: '',
      issues: issues,
      last_error: '',
    };
  });
}

/**
 * Determines the source posting index and destination posting indexes for a
 * transaction, or returns null if the shape is unsupported.
 *
 * Source selection heuristic: prefer a balance-sheet account ([A]/[L] prefix)
 * with a negative amount; fall back to the first balance-sheet account; fall
 * back to the single negative posting among all postings.
 *
 * Returns null for: mixed symbols, multiple negative non-balance-sheet legs,
 * two all-positive non-balance-sheet postings.
 *
 * @param {Object} transaction
 * @param {Object} [accountResourceToDisplayName]
 * @return {{sourceIndex: number|null, destinationIndexes: number[], symbol: string|null}|null}
 */
function classifySupportedTransaction_(transaction, accountResourceToDisplayName) {
  if (!transaction || !Array.isArray(transaction.postings)) {
    return null;
  }

  const postings = transaction.postings;

  if (postings.length === 0) {
    return { sourceIndex: null, destinationIndexes: [], symbol: null };
  }

  let symbol = null;
  for (let i = 0; i < postings.length; i++) {
    const p = postings[i];
    if (!p.units || p.cost || p.price) return null;
    if (symbol === null) symbol = p.units.symbol;
    else if (symbol !== p.units.symbol) return null;
  }

  const lookup = accountResourceToDisplayName || {};
  const balanceIndexes = [];
  for (let i = 0; i < postings.length; i++) {
    const name = lookup[postings[i].account] || '';
    if (name.startsWith('[A]') || name.startsWith('[L]')) balanceIndexes.push(i);
  }

  let sourceIndex;
  if (balanceIndexes.length > 0) {
    let negativeBalanceIndex = -1;
    for (let i = 0; i < balanceIndexes.length; i++) {
      if (parseFloat(postings[balanceIndexes[i]].units.amount) < 0) {
        negativeBalanceIndex = balanceIndexes[i];
        break;
      }
    }
    sourceIndex = negativeBalanceIndex >= 0 ? negativeBalanceIndex : balanceIndexes[0];
  } else {
    let negIndex = -1;
    for (let i = 0; i < postings.length; i++) {
      if (parseFloat(postings[i].units.amount) < 0) {
        if (negIndex >= 0) return null;
        negIndex = i;
      }
    }
    if (negIndex < 0) return null;
    sourceIndex = negIndex;
  }

  const destinationIndexes = [];
  for (let i = 0; i < postings.length; i++) {
    if (i !== sourceIndex) destinationIndexes.push(i);
  }
  return { sourceIndex: sourceIndex, destinationIndexes: destinationIndexes, symbol: symbol };
}

/**
 * Builds the API PATCH payload from the in-memory row data for a transaction.
 * Validates field consistency across rows and throws a descriptive error if the
 * transaction cannot be submitted as-is (missing/inconsistent fields, unknown
 * account names, mixed blank/non-blank destinations).
 *
 * @param {Object[]} rows - In-memory row objects (from findTransactionRowNumbersFromAnchor_).
 * @param {Object} accountDisplayNameToResource - Map of display_name → resource_name.
 * @return {Object} Payload suitable for PATCH /transactions/{name}.
 * @throws {Error} Joined issue list if any validation problem is found.
 */
function buildTransactionPatchPayload_(rows, accountDisplayNameToResource) {
  const issues = [];
  const sourceAccountName = requireSingleNormalizedValue_(
    rows,
    'source_account_name',
    'source account',
    issues
  );
  const symbol = requireSingleNormalizedValue_(rows, 'symbol', 'symbol', issues);
  const transactionDate = requireSingleNormalizedValue_(
    rows,
    'transaction_date',
    'transaction date',
    issues,
    normalizeTransactionDate_
  );
  const payee = readOptionalNormalizedValue_(rows, 'payee', 'payee', issues);
  const narration = inferTransactionNarrationFromGroupRows_(rows, issues);
  const isSplitTransaction = rows.length > 1;
  const sourceAccount = accountDisplayNameToResource[sourceAccountName];
  if (!sourceAccount) throw new Error('Unknown account_name: ' + sourceAccountName);
  const destinationRows = [];
  const blankDestinationRowNumbers = [];
  const amounts = [];

  rows.forEach(function(row, index) {
    const displayRow = row.__rowNumber || index + 2;
    const destinationAccountName = String(row.destination_account_name || '').trim();
    if (!destinationAccountName) {
      blankDestinationRowNumbers.push(displayRow);
    }

    const amount = row.amount;
    if (typeof amount !== 'number' || isNaN(amount)) {
      issues.push('Row ' + displayRow + ': invalid amount');
      return;
    }

    if (destinationAccountName) {
      const destinationAccount = accountDisplayNameToResource[destinationAccountName];
      if (!destinationAccount) throw new Error('Unknown account_name: ' + destinationAccountName);
      destinationRows.push({
        account: destinationAccount,
        amount: amount,
        narration: normalizePostingNarrationFromSheetRow_(row, narration, isSplitTransaction),
      });
    }
    amounts.push(amount);
  });

  if (blankDestinationRowNumbers.length > 0 && destinationRows.length > 0) {
    issues.push(
      'Rows for this transaction must either all have destination accounts or all leave destination_account_name blank.'
    );
  }
  if (blankDestinationRowNumbers.length > 1) {
    issues.push('A source-only transaction can only have one visible row.');
  }

  if (issues.length > 0) {
    throw new Error(issues.join('\n'));
  }

  const totalAmount = amounts.reduce(function(a, b) { return a + b; }, 0);
  const postings = [{
    account: sourceAccount,
    units: {
      amount: String(-totalAmount),
      symbol: symbol,
    },
  }];
  destinationRows.forEach(function(row) {
    postings.push({
      account: row.account,
      narration: row.narration,
      units: {
        amount: String(row.amount),
        symbol: symbol,
      },
    });
  });
  return {
    transaction_date: transactionDate,
    payee: payee,
    narration: narration,
    postings: postings,
  };
}

function requireSingleNormalizedValue_(rows, fieldName, label, issues, normalizer) {
  const values = rows.map(function(row) {
    const value = row[fieldName];
    return normalizer ? normalizer(value) : String(value || '').trim();
  });
  const distinct = uniqueNonBlankValues_(values);
  if (distinct.length === 0) {
    issues.push('Missing ' + label + ' across transaction rows.');
    return '';
  }
  if (distinct.length > 1) {
    issues.push('Inconsistent ' + label + ' across transaction rows.');
    return '';
  }
  return distinct[0];
}

function readOptionalNormalizedValue_(rows, fieldName, label, issues) {
  const values = rows.map(function(row) {
    return String(row[fieldName] || '').trim();
  });
  const distinct = uniqueNonBlankValues_(values);
  if (distinct.length > 1) {
    issues.push('Inconsistent ' + label + ' across transaction rows.');
    return null;
  }
  return distinct.length === 0 ? null : distinct[0];
}

/**
 * Finds the transaction that contains anchorRow and returns its span,
 * resource name, and in-memory row data.
 *
 * Scans a ±25-row window around the anchor, extending contiguously outward
 * until the resource_name changes. Always returns a contiguous span.
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {number} anchorRow - Any row number belonging to the target transaction.
 * @return {{span: {start: number, count: number}, transactionName: string, rows: Object[]}}
 * @throws {Error} If anchorRow does not belong to a transaction.
 */
function findTransactionRowNumbersFromAnchor_(sheet, anchorRow) {
  const txConfig = FAMILY_LEDGER_SHEET_REGISTRY.transactions;
  const windowStart = Math.max(2, anchorRow - 25);
  const windowEnd = anchorRow + 25;
  const windowRows = managedSheet_(sheet, txConfig).getRows({ start: windowStart, count: windowEnd - windowStart + 1 });
  const anchorIndex = anchorRow - windowStart;
  const transactionName = String(windowRows[anchorIndex].resource_name || '').trim();
  if (!transactionName) {
    throw new Error('The selected row does not contain a transaction.');
  }
  let firstIndex = anchorIndex;
  let lastIndex = anchorIndex;
  for (let i = anchorIndex - 1; i >= 0; i--) {
    if (String(windowRows[i].resource_name || '').trim() !== transactionName) break;
    firstIndex = i;
  }
  for (let i = anchorIndex + 1; i < windowRows.length; i++) {
    if (String(windowRows[i].resource_name || '').trim() !== transactionName) break;
    lastIndex = i;
  }
  const span = { start: windowStart + firstIndex, count: lastIndex - firstIndex + 1 };
  const rows = [];
  for (let i = 0; i < span.count; i++) {
    const row = Object.assign({}, windowRows[firstIndex + i]);
    row.__rowNumber = span.start + i;
    rows.push(row);
  }
  return { span: span, transactionName: transactionName, rows: rows };
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

function normalizeTransactionDate_(value) {
  if (Object.prototype.toString.call(value) === '[object Date]') {
    return Utilities.formatDate(value, 'UTC', 'yyyy-MM-dd');
  }
  return String(value || '').trim();
}

function effectiveSheetNarration_(transactionNarration, postingNarration) {
  const explicitPostingNarration = String(postingNarration || '');
  if (explicitPostingNarration) {
    return explicitPostingNarration;
  }
  return String(transactionNarration || '');
}

function normalizeOptionalSheetText_(value) {
  const normalized = String(value || '').trim();
  return normalized ? normalized : null;
}

function inferTransactionNarrationFromGroupRows_(rows, issues) {
  const transactionRows = rows.filter(function(row) {
    return String(row.narration_source || 'txn').trim() !== 'post';
  });
  if (transactionRows.length === 0) {
    issues.push('At least one split row must keep the transaction narration.');
    return null;
  }
  return normalizeOptionalSheetText_(transactionRows[0].narration);
}

function normalizePostingNarrationFromSheetRow_(row, transactionNarration, isSplitTransaction) {
  if (!isSplitTransaction) {
    return null;
  }
  const visibleNarration = normalizeOptionalSheetText_(row.narration);
  const sharedNarration = normalizeOptionalSheetText_(transactionNarration);
  if (visibleNarration === sharedNarration) {
    return null;
  }
  return visibleNarration;
}
