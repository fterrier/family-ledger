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
 * Finds the transaction that contains anchorRow and returns its row numbers,
 * resource name, and in-memory row data.
 *
 * Scans a ±25-row window around the anchor, extending contiguously outward
 * until the resource_name changes. Always returns contiguous, ascending row
 * numbers.
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {number} anchorRow - Any row number belonging to the target transaction.
 * @return {{rowNumbers: number[], transactionName: string, rows: Object[]}}
 * @throws {Error} If anchorRow does not belong to a transaction.
 */
function findTransactionRowNumbersFromAnchor_(sheet, anchorRow) {
  const headers = FAMILY_LEDGER_SHEET_REGISTRY.transactions.headers;
  const resourceNameColIndex = getTransactionHeaderColumnIndex_('resource_name') - 1;
  const windowStart = Math.max(2, anchorRow - 25);
  const windowEnd = anchorRow + 25;
  const values = sheet.getRange(windowStart, 1, windowEnd - windowStart + 1, headers.length).getValues();
  const anchorIndex = anchorRow - windowStart;
  const transactionName = String(values[anchorIndex][resourceNameColIndex] || '').trim();
  if (!transactionName) {
    throw new Error('The selected row does not contain a transaction.');
  }
  const rowNumbers = [];
  for (let i = anchorIndex; i >= 0; i--) {
    if (String(values[i][resourceNameColIndex] || '').trim() !== transactionName) break;
    rowNumbers.unshift(windowStart + i);
  }
  for (let i = anchorIndex + 1; i < values.length; i++) {
    if (String(values[i][resourceNameColIndex] || '').trim() !== transactionName) break;
    rowNumbers.push(windowStart + i);
  }
  const rows = rowNumbers.map(function(rn) {
    const row = rowToObject_(headers, values[rn - windowStart]);
    row.__rowNumber = rn;
    return row;
  });
  return { rowNumbers: rowNumbers, transactionName: transactionName, rows: rows };
}

/** Sets a field to a fixed value on each of the given row numbers. Binds the transactions sheet config. */
function setFieldValuesForRowNumbers_(sheet, rowNumbers, header, value) {
  setSheetFieldValuesForRowNumbers_(sheet, FAMILY_LEDGER_SHEET_REGISTRY.transactions, rowNumbers, header, value);
}

/** Writes a single row object to the sheet. Binds the transactions sheet config. */
function writeTransactionSheetRow_(sheet, rowNumber, row) {
  writeSheetRow_(sheet, FAMILY_LEDGER_SHEET_REGISTRY.transactions, rowNumber, row);
}

/** Converts a row object to a values array in transactions header order. Binds the transactions sheet config. */
function materializeTransactionSheetRow_(row) {
  return materializeSheetRow_(FAMILY_LEDGER_SHEET_REGISTRY.transactions, row);
}

function setTransactionSheetRows_(sheet, rows) {
  const materializedRows = rows.map(materializeTransactionSheetRow_);
  ensureSheetCapacity_(sheet, FAMILY_LEDGER_SHEET_REGISTRY.transactions.headers.length, materializedRows.length + 1);
  writeSheet_(sheet, FAMILY_LEDGER_SHEET_REGISTRY.transactions.headers, materializedRows);
  sheet.setFrozenRows(1);
  ensureTransactionIssueFormulas_(sheet, materializedRows.length);
}

/** Returns the 1-based column index for a transactions sheet header. Binds the transactions sheet config. */
function getTransactionHeaderColumnIndex_(header) {
  return getColumnIndex_(FAMILY_LEDGER_SHEET_REGISTRY.transactions, header);
}

/**
 * Deletes a contiguous block of transaction rows from the sheet.
 * rowNumbers must be ascending and contiguous (guaranteed by findTransactionRowNumbersFromAnchor_).
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {number[]} rowNumbers - Ascending contiguous row numbers to delete.
 */
function replaceTransactionRowsInSheet_(sheet, rowNumbers, replacementRows) {
  const targetRowNumbers = resizeContiguousRows_(sheet, rowNumbers[0], rowNumbers.length, replacementRows.length);
  if (targetRowNumbers.length === 0) return;
  sheet.getRange(targetRowNumbers[0], 1, targetRowNumbers.length, FAMILY_LEDGER_SHEET_REGISTRY.transactions.headers.length)
    .setValues(replacementRows.map(materializeTransactionSheetRow_));
  applyAccountValidationToRowNumbers_(sheet, targetRowNumbers);
}

/**
 * Writes issue-lookup formulas into the issues column for the given row numbers.
 * rowNumbers must be contiguous (they always come from buildSequentialRowNumbers_).
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {number[]} rowNumbers
 */
function applyTransactionIssueFormulasToRowNumbers_(sheet, rowNumbers) {
  if (!rowNumbers || rowNumbers.length === 0) return;
  const issuesColumn = getTransactionHeaderColumnIndex_('issues');
  const formulas = rowNumbers.map(function(rn) { return [buildIssueLookupFormula_(rn)]; });
  sheet.getRange(rowNumbers[0], issuesColumn, rowNumbers.length, 1).setFormulas(formulas);
}

function ensureTransactionIssueFormulas_(sheet, rowCount) {
  ensureManagedSheetIssueFormulas_(
    sheet,
    FAMILY_LEDGER_SHEET_REGISTRY.transactions,
    rowCount
  );
}

/**
 * Scans the transactions sheet and returns one anchor object per transaction,
 * in sheet order. Used by findInsertionRowForTransactionDate_ to locate the
 * correct insertion point for new transactions.
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @return {{transactionName: string, firstRow: number, lastRow: number, transactionDate: string}[]}
 */
function buildTransactionGroupAnchors_(sheet) {
  const lastRow = sheet.getLastRow();
  const anchors = [];
  if (lastRow <= 1) return anchors;
  const nameCol = getTransactionHeaderColumnIndex_('resource_name');
  const dateCol = getTransactionHeaderColumnIndex_('transaction_date');
  const startCol = Math.min(nameCol, dateCol);
  const colCount = Math.max(nameCol, dateCol) - startCol + 1;
  const values = sheet.getRange(2, startCol, lastRow - 1, colCount).getValues();
  let current = null;
  values.forEach(function(rowValues, index) {
    const transactionName = String(rowValues[nameCol - startCol] || '').trim();
    if (!transactionName) return;
    const rowNumber = index + 2;
    const transactionDate = normalizeTransactionDate_(rowValues[dateCol - startCol]);
    if (!current || current.transactionName !== transactionName) {
      if (current) anchors.push(current);
      current = { transactionName: transactionName, firstRow: rowNumber, lastRow: rowNumber, transactionDate: transactionDate };
      return;
    }
    current.lastRow = rowNumber;
  });
  if (current) anchors.push(current);
  return anchors;
}

function findInsertionRowForTransactionDate_(sheet, transactionDate) {
  const normalizedDate = normalizeTransactionDate_(transactionDate);
  const anchors = buildTransactionGroupAnchors_(sheet);
  for (let index = 0; index < anchors.length; index += 1) {
    if (anchors[index].transactionDate > normalizedDate) {
      return anchors[index].firstRow;
    }
  }
  const lastAnchor = anchors[anchors.length - 1];
  return lastAnchor ? lastAnchor.lastRow + 1 : 2;
}

/**
 * Applies a flattened API response to the transactions sheet after a save.
 * Handles three cases:
 *   - New transaction (rowNumbers=null): inserts rows at the date-sorted position.
 *   - Same posting count: writes replacement data in place, no structural change.
 *   - Count changed: uses resizeContiguousRows_ to insert/delete, then writes.
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {number[]|null} rowNumbers - Existing row numbers for PATCH; null for POST.
 * @param {Object[]} replacementRows - Flattened row objects with status/split_off_amount stamped.
 * @return {number[]} Final row numbers where data was written.
 */
function applyTransactionResponseToSheet_(sheet, rowNumbers, replacementRows) {
  let targetRowNumbers;
  if (!rowNumbers) {
    // New transaction: insert rows at date-sorted position
    const insertionRow = findInsertionRowForTransactionDate_(sheet, replacementRows[0].transaction_date);
    const lastRow = sheet.getLastRow();
    let startRow;
    if (lastRow <= 1) {
      startRow = 2;
    } else if (insertionRow <= lastRow) {
      sheet.insertRowsBefore(insertionRow, replacementRows.length);
      startRow = insertionRow;
    } else {
      sheet.insertRowsAfter(Math.max(lastRow, 1), replacementRows.length);
      startRow = Math.max(lastRow + 1, 2);
    }
    targetRowNumbers = buildSequentialRowNumbers_(startRow, replacementRows.length);
  } else if (rowNumbers.length === replacementRows.length) {
    // Same count: write in place without structural changes
    targetRowNumbers = rowNumbers;
  } else {
    // Count changed: adjust row count then write (transactions are always contiguous)
    const firstRow = rowNumbers.slice().sort(function(a, b) { return a - b; })[0];
    targetRowNumbers = resizeContiguousRows_(sheet, firstRow, rowNumbers.length, replacementRows.length);
  }

  sheet.getRange(targetRowNumbers[0], 1, targetRowNumbers.length, FAMILY_LEDGER_SHEET_REGISTRY.transactions.headers.length)
    .setValues(replacementRows.map(materializeTransactionSheetRow_));
  applyAccountValidationToRowNumbers_(sheet, targetRowNumbers);
  applyTransactionIssueFormulasToRowNumbers_(sheet, targetRowNumbers);
  return targetRowNumbers;
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
