function handleTransactionEdit(e) {
  if (!e || !e.range) {
    return;
  }

  const sheet = e.range.getSheet();
  if (sheet.getName() !== FAMILY_LEDGER_SHEET_NAMES.transactions) {
    return;
  }

  const row = e.range.getRow();
  const column = e.range.getColumn();
  if (row <= 1) {
    return;
  }

  const header = FAMILY_LEDGER_SHEET_REGISTRY.transactions.headers[column - 1];
  if (
    header !== 'payee' &&
    header !== 'narration' &&
    header !== 'destination_account_name' &&
    header !== 'amount' &&
    header !== 'split_off_amount'
  ) {
    return;
  }

  debugLog_('handleTransactionEdit', { row: row, header: header });

  try {
    applyTransactionEdit_(sheet, row, header, e.range.getValue() ?? '', String(e.oldValue ?? ''), {
      showSuccessToast: true,
    });
  } catch (error) {
    rollbackFailedEdit_(sheet, row, header, String(e.oldValue ?? ''));
    handleAutomaticEditError_(sheet, row, error);
  }
}

function applyTransactionEdit_(sheet, rowNumber, header, rawValue, oldRawValue, saveOptions) {
  let precomputed = null;
  if (header === 'split_off_amount') {
    const splitValue = String(rawValue ?? '').trim();
    if (!splitValue) {
      return;
    }
    performSplitInstructionForRow_(sheet, rowNumber, splitValue);
  } else if (header === 'payee') {
    precomputed = propagateTransactionField_(sheet, rowNumber, header, String(rawValue || ''));
  } else if (header === 'narration') {
    precomputed = applyNarrationEdit_(sheet, rowNumber, String(rawValue || ''));
  } else if (header === 'amount') {
    handleAmountEdit_(sheet, rowNumber, rawValue, oldRawValue);
  }

  saveTransactionByName_(sheet, rowNumber, saveOptions || {}, precomputed);
}

function performSplitForRow_(sheet, rowNumber, rawSplitAmount) {
  const { rowNumbers } = findTransactionRowNumbersFromAnchor_(sheet, rowNumber);
  const groupRows = readTransactionSheetRowsByNumbers_(sheet, rowNumbers);
  const row = groupRows.find(function(r) { return r.__rowNumber === rowNumber; });
  if (!row || !row.resource_name) {
    throw new Error('The selected row does not contain a transaction.');
  }
  if (groupRows.every(function(r) { return !String(r.destination_account_name || '').trim(); })) {
    throw new Error('Split is unavailable until a destination account is set.');
  }

  const splitAmount = parseFloat(rawSplitAmount);
  const originalAmount = row.amount;
  if (splitAmount === originalAmount) {
    throw new Error('Split amount must differ from the row amount.');
  }

  const newRow = cloneTransactionSheetRow_(row);
  newRow.amount = splitAmount;
  newRow.split_off_amount = '';
  newRow.status = 'dirty';
  newRow.last_error = '';
  resetNewSplitRowNarration_(newRow, inferTransactionNarrationFromSiblingRows_(groupRows, rowNumber, row));

  row.amount = originalAmount - splitAmount;
  row.split_off_amount = '';
  row.status = 'dirty';
  row.last_error = '';

  sheet.insertRowsAfter(rowNumber, 1);
  writeTransactionSheetRow_(sheet, rowNumber, row);
  writeTransactionSheetRow_(sheet, rowNumber + 1, newRow);
  applyAccountValidationToRowNumbers_(sheet, [rowNumber + 1]);
  focusPostEnterAfterInsert_(sheet, rowNumber, getTransactionHeaderColumnIndex_('split_off_amount'));
}

function performSplitFromEditedAmount_(sheet, rowNumber, oldAmount, newAmount, row, groupRows) {
  const splitAmount = oldAmount - newAmount;
  const newRow = cloneTransactionSheetRow_(row);
  newRow.amount = splitAmount;
  newRow.split_off_amount = '';
  newRow.status = 'dirty';
  newRow.last_error = '';
  resetNewSplitRowNarration_(newRow, inferTransactionNarrationFromSiblingRows_(groupRows, rowNumber, row));

  row.amount = newAmount;
  row.split_off_amount = '';
  row.status = 'dirty';
  row.last_error = '';

  sheet.insertRowsAfter(rowNumber, 1);
  writeTransactionSheetRow_(sheet, rowNumber, row);
  writeTransactionSheetRow_(sheet, rowNumber + 1, newRow);
  applyAccountValidationToRowNumbers_(sheet, [rowNumber + 1]);
  focusPostEnterAfterInsert_(sheet, rowNumber, getTransactionHeaderColumnIndex_('amount'));
}

function performSplitInstructionForRow_(sheet, rowNumber, instruction) {
  const normalizedInstruction = String(instruction ?? '').trim();
  if (!normalizedInstruction) {
    return;
  }
  if (normalizedInstruction === 'x' || normalizedInstruction === 'X' || normalizedInstruction === '-') {
    performDeleteSplitRow_(sheet, rowNumber);
    return;
  }
  performSplitForRow_(sheet, rowNumber, normalizedInstruction);
}

function performDeleteSplitRow_(sheet, rowNumber) {
  const row = readSheetRow_(sheet, FAMILY_LEDGER_SHEET_REGISTRY.transactions, rowNumber);
  if (!row || !row.resource_name) {
    throw new Error('The selected row does not contain a transaction.');
  }

  const { rowNumbers } = findTransactionRowNumbersFromAnchor_(sheet, rowNumber);
  if (rowNumbers.length <= 1) {
    row.destination_account_name = '';
    row.split_off_amount = '';
    row.status = 'dirty';
    row.last_error = '';
    row.narration_source = 'txn';
    writeTransactionSheetRow_(sheet, rowNumber, row);
    focusPostEnterAfterDelete_(sheet, rowNumber, getTransactionHeaderColumnIndex_('split_off_amount'));
    return;
  }

  const currentIndex = rowNumbers.indexOf(rowNumber);
  const mergeTargetRowNumber = currentIndex > 0 ? rowNumbers[currentIndex - 1] : rowNumbers[currentIndex + 1];
  const mergeTarget = readSheetRow_(sheet, FAMILY_LEDGER_SHEET_REGISTRY.transactions, mergeTargetRowNumber);
  mergeTarget.amount = mergeTarget.amount + row.amount;
  mergeTarget.split_off_amount = '';
  mergeTarget.status = 'dirty';
  mergeTarget.last_error = '';
  if (rowNumbers.length === 2) {
    mergeTarget.narration_source = 'txn';
  }

  if (mergeTargetRowNumber < rowNumber) {
    writeTransactionSheetRow_(sheet, mergeTargetRowNumber, mergeTarget);
    sheet.deleteRow(rowNumber);
    focusPostEnterAfterDelete_(sheet, rowNumber, getTransactionHeaderColumnIndex_('split_off_amount'));
  } else {
    sheet.deleteRow(rowNumber);
    writeTransactionSheetRow_(sheet, mergeTargetRowNumber - 1, mergeTarget);
    focusPostEnterAfterDelete_(sheet, rowNumber, getTransactionHeaderColumnIndex_('split_off_amount'));
  }
}

function focusPostEnterAfterInsert_(sheet, editedRowNumber, editedColumnNumber) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 1) {
    return;
  }
  focusCell_(sheet, Math.min(editedRowNumber + 1, lastRow), editedColumnNumber);
}

function focusPostEnterAfterDelete_(sheet, editedRowNumber, editedColumnNumber) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 1) {
    return;
  }
  focusCell_(sheet, Math.min(editedRowNumber, lastRow), editedColumnNumber);
}

function focusCell_(sheet, rowNumber, columnNumber) {
  sheet.getRange(rowNumber, columnNumber).activate();
}

function handleAmountEdit_(sheet, rowNumber, rawValue, oldRawValue) {
  const { rowNumbers } = findTransactionRowNumbersFromAnchor_(sheet, rowNumber);
  const groupRows = readTransactionSheetRowsByNumbers_(sheet, rowNumbers);
  const row = groupRows.find(function(r) { return r.__rowNumber === rowNumber; });

  if (groupRows.every(function(r) { return !String(r.destination_account_name || '').trim(); })) {
    restoreAmountCell_(sheet, rowNumber, normalizedFallbackAmount_(oldRawValue));
    throw new Error('Amount cannot be edited until a destination account is set.');
  }

  const oldAmount = parseFloat(oldRawValue);
  const newAmount = parseFloat(rawValue);
  if (isNaN(oldAmount)) {
    setFieldValuesForRowNumbers_(sheet, rowNumbers, 'status', 'dirty');
    setFieldValuesForRowNumbers_(sheet, rowNumbers, 'last_error', '');
    return;
  }

  if (isNaN(newAmount)) {
    restoreAmountCell_(sheet, rowNumber, normalizedFallbackAmount_(oldRawValue));
    throw new Error('Invalid amount — enter a valid number.');
  }

  if (newAmount === oldAmount) {
    setFieldValuesForRowNumbers_(sheet, rowNumbers, 'status', 'dirty');
    setFieldValuesForRowNumbers_(sheet, rowNumbers, 'last_error', '');
    return;
  }

  performSplitFromEditedAmount_(sheet, rowNumber, oldAmount, newAmount, row, groupRows);
}

function restoreAmountCell_(sheet, rowNumber, amount) {
  sheet.getRange(rowNumber, getTransactionHeaderColumnIndex_('amount')).setValue(amount);
}

function clearSplitInstructionCell_(sheet, rowNumber) {
  sheet.getRange(rowNumber, getTransactionHeaderColumnIndex_('split_off_amount')).setValue('');
}

function rollbackFailedEdit_(sheet, rowNumber, header, oldValue) {
  if (header === 'amount') {
    restoreAmountCell_(sheet, rowNumber, normalizedFallbackAmount_(oldValue));
    return;
  }
  if (header === 'split_off_amount') {
    clearSplitInstructionCell_(sheet, rowNumber);
  }
}

function normalizedFallbackAmount_(amount) {
  const n = parseFloat(amount);
  return isNaN(n) ? '' : n;
}

function propagateTransactionField_(sheet, rowNumber, header, value) {
  const { rowNumbers, transactionName } = findTransactionRowNumbersFromAnchor_(sheet, rowNumber);
  setFieldValuesForRowNumbers_(sheet, rowNumbers, header, value);
  setFieldValuesForRowNumbers_(sheet, rowNumbers, 'status', 'dirty');
  setFieldValuesForRowNumbers_(sheet, rowNumbers, 'last_error', '');
  return { rowNumbers: rowNumbers, transactionName: transactionName };
}

function applyNarrationEdit_(sheet, rowNumber, value) {
  const { rowNumbers, transactionName } = findTransactionRowNumbersFromAnchor_(sheet, rowNumber);
  if (rowNumbers.length <= 1) {
    applySingleRowTransactionNarrationEdit_(sheet, rowNumber, value);
    markTransactionRowsDirty_(sheet, rowNumbers);
    return { rowNumbers: rowNumbers, transactionName: transactionName };
  }

  applySplitRowPostingNarrationEdit_(sheet, rowNumber, rowNumbers, value);
  markTransactionRowsDirty_(sheet, rowNumbers);
  return { rowNumbers: rowNumbers, transactionName: transactionName };
}

function applySingleRowTransactionNarrationEdit_(sheet, rowNumber, value) {
  const row = readSheetRow_(sheet, FAMILY_LEDGER_SHEET_REGISTRY.transactions, rowNumber);
  row.narration_source = 'txn';
  row.narration = value;
  writeTransactionSheetRow_(sheet, rowNumber, row);
}

function applySplitRowPostingNarrationEdit_(sheet, rowNumber, rowNumbers, value) {
  const row = readSheetRow_(sheet, FAMILY_LEDGER_SHEET_REGISTRY.transactions, rowNumber);
  const groupRows = readTransactionSheetRowsByNumbers_(sheet, rowNumbers);
  const transactionNarration = inferTransactionNarrationFromSiblingRows_(groupRows, rowNumber, row);
  const normalizedValue = String(value || '');

  if (!normalizedValue.trim() || normalizedValue === transactionNarration) {
    row.narration_source = 'txn';
    row.narration = transactionNarration;
  } else {
    ensureSplitTransactionRetainsTransactionNarration_(groupRows, rowNumber, row, normalizedValue, transactionNarration);
    row.narration_source = 'post';
    row.narration = normalizedValue;
  }

  writeTransactionSheetRow_(sheet, rowNumber, row);
}

function resetNewSplitRowNarration_(row, transactionNarration) {
  row.narration_source = 'txn';
  row.narration = String(transactionNarration || '');
}

function markTransactionRowsDirty_(sheet, rowNumbers) {
  setFieldValuesForRowNumbers_(sheet, rowNumbers, 'status', 'dirty');
  setFieldValuesForRowNumbers_(sheet, rowNumbers, 'last_error', '');
}

function clearTransactionErrors_(sheet, rowNumber) {
  const { rowNumbers } = findTransactionRowNumbersFromAnchor_(sheet, rowNumber);
  setFieldValuesForRowNumbers_(sheet, rowNumbers, 'status', 'dirty');
  setFieldValuesForRowNumbers_(sheet, rowNumbers, 'last_error', '');
}

function inferTransactionNarrationFromSiblingRows_(groupRows, rowNumber, row) {
  const sibling = groupRows.find(function(groupRow) {
    return groupRow.__rowNumber !== rowNumber && String(groupRow.narration_source || 'txn').trim() !== 'post';
  });
  if (sibling) {
    return String(sibling.narration || '');
  }
  return String(row.narration || '');
}

function inferTransactionNarrationForSplitRow_(sheet, rowNumber, row) {
  const { rowNumbers } = findTransactionRowNumbersFromAnchor_(sheet, rowNumber);
  const groupRows = readTransactionSheetRowsByNumbers_(sheet, rowNumbers);
  return inferTransactionNarrationFromSiblingRows_(groupRows, rowNumber, row);
}

function ensureSplitTransactionRetainsTransactionNarration_(groupRows, rowNumber, row, newValue, transactionNarration) {
  const isTxnRow = String(row.narration_source || 'txn').trim() !== 'post';
  if (!isTxnRow) {
    return;
  }
  const otherTransactionRows = groupRows.filter(function(groupRow) {
    return groupRow.__rowNumber !== rowNumber && String(groupRow.narration_source || 'txn').trim() !== 'post';
  });
  if (otherTransactionRows.length === 0 && String(newValue || '') !== transactionNarration) {
    throw new Error('At least one split row must keep the transaction narration.');
  }
}

function handleAutomaticEditError_(sheet, rowNumber, error) {
  try {
    const { rowNumbers } = findTransactionRowNumbersFromAnchor_(sheet, rowNumber);
    setFieldValuesForRowNumbers_(sheet, rowNumbers, 'status', 'error');
    setFieldValuesForRowNumbers_(sheet, rowNumbers, 'last_error', error.message || String(error));
  } catch (_e) {
    // Row has no transaction — status fields cannot be updated
  }
  SpreadsheetApp.getActiveSpreadsheet().toast(error.message || String(error), 'Family Ledger', 5);
}
