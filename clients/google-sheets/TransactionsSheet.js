function flattenTransactionForSheet_(transaction, accountNameLookup) {
  const shape = classifySupportedTransaction_(transaction, accountNameLookup);
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
  const sourceAccountName = accountNameLookup[sourcePosting.account] || sourcePosting.account;
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
      destination_account_name: accountNameLookup[posting.account] || posting.account,
      amount: parseFloat(posting.units.amount),
      split_off_amount: '',
      symbol: posting.units.symbol,
      status: '',
      issues: issues,
      last_error: '',
    };
  });
}

function classifySupportedTransaction_(transaction, accountNameLookup) {
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

  const lookup = accountNameLookup || {};
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

function buildTransactionPatchPayloadFromGroup_(group, accountNameMap) {
  const issues = [];
  const sourceAccountName = requireSingleNormalizedValue_(
    group.rows,
    'source_account_name',
    'source account',
    issues
  );
  const symbol = requireSingleNormalizedValue_(group.rows, 'symbol', 'symbol', issues);
  const transactionDate = requireSingleNormalizedValue_(
    group.rows,
    'transaction_date',
    'transaction date',
    issues,
    normalizeTransactionDate_
  );
  const payee = readOptionalNormalizedValue_(group.rows, 'payee', 'payee', issues);
  const narration = inferTransactionNarrationFromGroupRows_(group.rows, issues);
  const isSplitTransaction = group.rows.length > 1;
  const sourceAccount = resolveAccountResourceName_(accountNameMap, sourceAccountName);
  const destinationRows = [];
  const blankDestinationRowNumbers = [];
  const amounts = [];

  group.rows.forEach(function(row, index) {
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
      destinationRows.push({
        account: resolveAccountResourceName_(accountNameMap, destinationAccountName),
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
  if (!group.contiguous) {
    issues.push('Rows for this transaction are not contiguous. You can still push, but Regroup Active Transaction is recommended.');
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

function isSourceOnlyTransactionRow_(sheet, rowNumber) {
  if (!sheet || typeof sheet.getRange !== 'function') {
    return false;
  }
  const probeRange = sheet.getRange(
    rowNumber,
    1,
    1,
    FAMILY_LEDGER_SHEET_REGISTRY.transactions.headers.length
  );
  if (!probeRange || typeof probeRange.getValues !== 'function') {
    return false;
  }
  const row = readSheetRow_(sheet, FAMILY_LEDGER_SHEET_REGISTRY.transactions, rowNumber);
  const transactionName = row && row.resource_name ? String(row.resource_name).trim() : '';
  if (!transactionName) {
    return false;
  }
  const rowNumbers = findTransactionRowNumbers_(sheet, transactionName);
  const rows = readTransactionSheetRowsByNumbers_(sheet, rowNumbers);
  return rows.every(function(groupRow) {
    return !String(groupRow.destination_account_name || '').trim();
  });
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

function getTransactionNameForRow_(sheet, rowNumber) {
  if (rowNumber <= 1) {
    return '';
  }
  return String(sheet.getRange(rowNumber, getTransactionHeaderColumnIndex_('resource_name')).getValue() || '').trim();
}

function readTransactionNameColumnValues_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) {
    return [];
  }
  return sheet
    .getRange(2, getTransactionHeaderColumnIndex_('resource_name'), lastRow - 1, 1)
    .getValues()
    .map(function(row) {
      return String(row[0] || '').trim();
    });
}

function findTransactionRowNumbersFromColumnValues_(columnValues, transactionName) {
  const rowNumbers = [];
  columnValues.forEach(function(value, index) {
    if (value === transactionName) {
      rowNumbers.push(index + 2);
    }
  });
  if (rowNumbers.length === 0) {
    throw new Error('Transaction ' + transactionName + ' is not present in the sheet.');
  }
  return rowNumbers;
}

function findTransactionRowNumbers_(sheet, transactionName) {
  return findTransactionRowNumbersFromColumnValues_(readTransactionNameColumnValues_(sheet), transactionName);
}

function setFieldValuesForRowNumbers_(sheet, rowNumbers, header, value) {
  setSheetFieldValuesForRowNumbers_(sheet, FAMILY_LEDGER_SHEET_REGISTRY.transactions, rowNumbers, header, value);
}

function updateTransactionRowsInPlace_(sheet, rowNumbers, existingRows, replacementRows) {
  rowNumbers.forEach(function(rowNumber, index) {
    const existingRow = existingRows[index] || {};
    const replacementRow = replacementRows[index] || {};
    const changedHeaders = FAMILY_LEDGER_SHEET_REGISTRY.transactions.headers.filter(function(header) {
      return normalizeSheetCellValue_(existingRow[header]) !== normalizeSheetCellValue_(replacementRow[header]);
    });

    changedHeaders.forEach(function(header) {
      sheet.getRange(rowNumber, getTransactionHeaderColumnIndex_(header)).setValue(replacementRow[header] ?? '');
    });
  });
}

function canUpdateTransactionRowsInPlace_(existingRows, replacementRows) {
  if (existingRows.length !== replacementRows.length || existingRows.length === 0) {
    return false;
  }

  for (let index = 0; index < existingRows.length; index += 1) {
    const existingRow = existingRows[index];
    const replacementRow = replacementRows[index];
    if (
      normalizeSheetCellValue_(existingRow.resource_name) !== normalizeSheetCellValue_(replacementRow.resource_name) ||
      normalizeSheetCellValue_(existingRow.source_account_name) !== normalizeSheetCellValue_(replacementRow.source_account_name) ||
      normalizeSheetCellValue_(existingRow.symbol) !== normalizeSheetCellValue_(replacementRow.symbol)
    ) {
      return false;
    }
  }

  return true;
}

function areTransactionRowsEquivalentForRefresh_(existingRows, replacementRows) {
  if (existingRows.length !== replacementRows.length) {
    return false;
  }

  for (let index = 0; index < existingRows.length; index += 1) {
    const existingComparable = comparableTransactionSheetRow_(existingRows[index]);
    const replacementComparable = comparableTransactionSheetRow_(replacementRows[index]);
    if (JSON.stringify(existingComparable) !== JSON.stringify(replacementComparable)) {
      return false;
    }
  }

  return true;
}

function comparableTransactionSheetRow_(row) {
  return {
    resource_name: normalizeSheetCellValue_(row.resource_name),
    narration_source: normalizeSheetCellValue_(row.narration_source),
    transaction_date: normalizeSheetCellValue_(row.transaction_date),
    payee: normalizeSheetCellValue_(row.payee),
    narration: normalizeSheetCellValue_(row.narration),
    source_account_name: normalizeSheetCellValue_(row.source_account_name),
    destination_account_name: normalizeSheetCellValue_(row.destination_account_name),
    amount: normalizeSheetCellValue_(row.amount),
    symbol: normalizeSheetCellValue_(row.symbol),
    issues: normalizeSheetCellValue_(row.issues),
  };
}

function normalizeSheetCellValue_(value) {
  if (Object.prototype.toString.call(value) === '[object Date]') {
    return normalizeTransactionDate_(value);
  }
  return String(value ?? '');
}

function readTransactionSheetRowsByNumbers_(sheet, rowNumbers) {
  return readSheetRowsByNumbers_(sheet, FAMILY_LEDGER_SHEET_REGISTRY.transactions, rowNumbers);
}

function writeTransactionSheetRow_(sheet, rowNumber, row) {
  writeSheetRow_(sheet, FAMILY_LEDGER_SHEET_REGISTRY.transactions, rowNumber, row);
}

function materializeTransactionSheetRow_(row) {
  return materializeSheetRow_(FAMILY_LEDGER_SHEET_REGISTRY.transactions, row);
}

function setTransactionSheetRows_(sheet, rows) {
  const materializedRows = rows.map(materializeTransactionSheetRow_);
  writeSheet_(sheet, FAMILY_LEDGER_SHEET_REGISTRY.transactions.headers, materializedRows);
  sheet.setFrozenRows(1);
  ensureTransactionIssueFormulas_(sheet, materializedRows.length);
}

function requireTransactionSheet_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  if (sheet.getName() !== FAMILY_LEDGER_SHEET_NAMES.transactions) {
    throw new Error('Select the Transactions sheet first.');
  }
  return sheet;
}

function getActiveTransactionGroupFromSheet_(sheet) {
  const activeRowNumber = sheet.getActiveRange().getRow();
  if (activeRowNumber <= 1) {
    throw new Error('Select a transaction data row first.');
  }

  const transactionName = getTransactionNameForRow_(sheet, activeRowNumber);
  if (!transactionName) {
    throw new Error('The selected row does not contain a transaction.');
  }

  const rowNumbers = findTransactionRowNumbers_(sheet, transactionName);
  return {
    transactionName: transactionName,
    activeIndex: rowNumbers.indexOf(activeRowNumber),
    rowNumbers: rowNumbers,
    rows: readTransactionSheetRowsByNumbers_(sheet, rowNumbers),
    contiguous: isContiguousRowNumbers_(rowNumbers),
  };
}

function getTransactionHeaderColumnIndex_(header) {
  return getColumnIndex_(FAMILY_LEDGER_SHEET_REGISTRY.transactions, header);
}

function buildContiguousRowSpans_(rowNumbers) {
  if (rowNumbers.length === 0) {
    return [];
  }
  const sorted = rowNumbers.slice().sort(function(left, right) {
    return left - right;
  });
  const spans = [];
  let start = sorted[0];
  let end = sorted[0];

  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index] === end + 1) {
      end = sorted[index];
      continue;
    }
    spans.push({ start: start, count: end - start + 1 });
    start = sorted[index];
    end = sorted[index];
  }
  spans.push({ start: start, count: end - start + 1 });
  return spans;
}

function isContiguousRowNumbers_(rowNumbers) {
  if (rowNumbers.length <= 1) {
    return true;
  }
  const sorted = rowNumbers.slice().sort(function(left, right) {
    return left - right;
  });
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index] !== sorted[index - 1] + 1) {
      return false;
    }
  }
  return true;
}

function replaceTransactionRowsInSheet_(sheet, rowNumbers, replacementRows) {
  const sortedRowNumbers = rowNumbers.slice().sort(function(left, right) {
    return left - right;
  });
  const firstRowNumber = sortedRowNumbers[0];
  const deletionSpans = buildContiguousRowSpans_(sortedRowNumbers).sort(function(left, right) {
    return right.start - left.start;
  });

  deletionSpans.forEach(function(span) {
    sheet.deleteRows(span.start, span.count);
  });

  if (replacementRows.length === 0) {
    return;
  }

  let insertionRow = firstRowNumber;
  if (insertionRow > sheet.getLastRow() + 1) {
    insertionRow = sheet.getLastRow() + 1;
  }

  if (insertionRow <= sheet.getLastRow()) {
    sheet.insertRowsBefore(insertionRow, replacementRows.length);
  } else {
    sheet.insertRowsAfter(Math.max(sheet.getLastRow(), 1), replacementRows.length);
    insertionRow = Math.max(sheet.getLastRow() - replacementRows.length + 1, 2);
  }

  sheet
    .getRange(insertionRow, 1, replacementRows.length, FAMILY_LEDGER_SHEET_REGISTRY.transactions.headers.length)
    .setValues(replacementRows.map(materializeTransactionSheetRow_));
  applyAccountValidationToRowNumbers_(sheet, buildSequentialRowNumbers_(insertionRow, replacementRows.length));
}

function buildSequentialRowNumbers_(startRow, count) {
  const rowNumbers = [];
  for (let index = 0; index < count; index += 1) {
    rowNumbers.push(startRow + index);
  }
  return rowNumbers;
}

function cloneTransactionSheetRow_(row) {
  const clone = {};
  Object.keys(row).forEach(function(key) {
    clone[key] = row[key];
  });
  return clone;
}


function ensureTransactionIssueFormulas_(sheet, rowCount) {
  ensureManagedSheetIssueFormulas_(
    sheet,
    FAMILY_LEDGER_SHEET_REGISTRY.transactions,
    rowCount
  );
}


function normalizeTransactionDate_(value) {
  if (Object.prototype.toString.call(value) === '[object Date]') {
    return Utilities.formatDate(value, 'UTC', 'yyyy-MM-dd');
  }
  return String(value || '').trim();
}

function uniqueNonBlankValues_(values) {
  const unique = [];
  values.forEach(function(value) {
    if (!value) {
      return;
    }
    if (unique.indexOf(value) === -1) {
      unique.push(value);
    }
  });
  return unique;
}

function rowToObject_(headers, rowValues) {
  const result = {};
  headers.forEach(function(header, index) {
    result[header] = rowValues[index];
  });
  return result;
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
