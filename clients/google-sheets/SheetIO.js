function readVisibleTransactionRows_(sheet) {
  const lastRow = sheet.getLastRow();
  const rowNumbers = [];
  const rows = [];
  if (lastRow <= 1) {
    return { rowNumbers: rowNumbers, rows: rows };
  }
  for (let rowNumber = 2; rowNumber <= lastRow; rowNumber += 1) {
    const row = readTransactionSheetRow_(sheet, rowNumber);
    if (!row || !row.transaction_name) {
      continue;
    }
    rowNumbers.push(rowNumber);
    rows.push(row);
  }
  return { rowNumbers: rowNumbers, rows: rows };
}

function getTransactionNameForRow_(sheet, rowNumber) {
  if (rowNumber <= 1) {
    return '';
  }
  return String(sheet.getRange(rowNumber, getTransactionHeaderColumnIndex_('transaction_name')).getValue() || '').trim();
}

function readTransactionNameColumnValues_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) {
    return [];
  }
  return sheet
    .getRange(2, getTransactionHeaderColumnIndex_('transaction_name'), lastRow - 1, 1)
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

function readTransactionSheetRow_(sheet, rowNumber) {
  const values = sheet.getRange(rowNumber, 1, 1, FAMILY_LEDGER_TRANSACTION_HEADERS.length).getValues()[0];
  const row = rowToObject_(FAMILY_LEDGER_TRANSACTION_HEADERS, values);
  row.__rowNumber = rowNumber;
  return row;
}

function setFieldValuesForRowNumbers_(sheet, rowNumbers, header, value) {
  const column = getTransactionHeaderColumnIndex_(header);
  rowNumbers.forEach(function(rowNumber) {
    sheet.getRange(rowNumber, column).setValue(value);
  });
}

function updateTransactionRowsInPlace_(sheet, rowNumbers, existingRows, replacementRows) {
  rowNumbers.forEach(function(rowNumber, index) {
    const existingRow = existingRows[index] || {};
    const replacementRow = replacementRows[index] || {};
    const changedHeaders = FAMILY_LEDGER_TRANSACTION_HEADERS.filter(function(header) {
      return normalizeSheetCellValue_(existingRow[header]) !== normalizeSheetCellValue_(replacementRow[header]);
    });

    changedHeaders.forEach(function(header) {
      sheet.getRange(rowNumber, getTransactionHeaderColumnIndex_(header)).setValue(replacementRow[header] ?? '');
    });
  });
  applyTransactionIssueHighlightingToRowNumbers_(sheet, rowNumbers, replacementRows);
}

function canUpdateTransactionRowsInPlace_(existingRows, replacementRows) {
  if (existingRows.length !== replacementRows.length || existingRows.length === 0) {
    return false;
  }

  for (let index = 0; index < existingRows.length; index += 1) {
    const existingRow = existingRows[index];
    const replacementRow = replacementRows[index];
    if (
      normalizeSheetCellValue_(existingRow.transaction_name) !== normalizeSheetCellValue_(replacementRow.transaction_name) ||
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
    transaction_name: normalizeSheetCellValue_(row.transaction_name),
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
  return rowNumbers.map(function(rowNumber) {
    return readTransactionSheetRow_(sheet, rowNumber);
  });
}

function writeTransactionSheetRow_(sheet, rowNumber, row) {
  sheet
    .getRange(rowNumber, 1, 1, FAMILY_LEDGER_TRANSACTION_HEADERS.length)
    .setValues([materializeTransactionSheetRow_(row)]);
  applyTransactionIssueHighlightingToRowNumbers_(sheet, [rowNumber], [row]);
}

function materializeTransactionSheetRow_(row) {
  return FAMILY_LEDGER_TRANSACTION_HEADERS.map(function(header) {
    return row[header] ?? '';
  });
}

function setTransactionSheetRows_(sheet, rows) {
  const materializedRows = rows.map(materializeTransactionSheetRow_);
  writeSheet_(sheet, FAMILY_LEDGER_TRANSACTION_HEADERS, materializedRows);
  sheet.setFrozenRows(1);
  ensureTransactionIssueFormulas_(sheet, materializedRows.length);
  applyAccountValidation_(sheet, materializedRows.length);
  applyTransactionSheetLayout_(sheet, rows);
  ensureIssueConditionalFormatting_(sheet, FAMILY_LEDGER_TRANSACTION_HEADERS);
  protectTransactionSheet_(sheet);
  hideTechnicalTransactionColumns_(sheet);
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
  return FAMILY_LEDGER_TRANSACTION_HEADERS.indexOf(header) + 1;
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
    .getRange(insertionRow, 1, replacementRows.length, FAMILY_LEDGER_TRANSACTION_HEADERS.length)
    .setValues(replacementRows.map(materializeTransactionSheetRow_));
  applyTransactionIssueHighlightingToRowNumbers_(
    sheet,
    buildSequentialRowNumbers_(insertionRow, replacementRows.length),
    replacementRows
  );
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

function getOrCreateSheet_(sheetName) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(sheetName);
  }
  return sheet;
}

function hideSheetIfVisible_(sheet) {
  if (!sheet.isSheetHidden || !sheet.isSheetHidden()) {
    sheet.hideSheet();
  }
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
    'transaction_date',
    'source_account_name',
    'symbol',
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

function hideTechnicalTransactionColumns_(sheet) {
  const transactionNameColumn = getTransactionHeaderColumnIndex_('transaction_name');
  const lastErrorColumn = getTransactionHeaderColumnIndex_('last_error');
  sheet.hideColumns(transactionNameColumn);
  sheet.hideColumns(lastErrorColumn);
}
