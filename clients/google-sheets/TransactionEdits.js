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

  if (header === 'edit' && (e.value === true || e.value === 'TRUE')) {
    openEditTransactionSidebar_(sheet, row);
    return;
  }

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
    const editValue = header === 'amount' ? (e.range.getValue() ?? '') : (e.value ?? '');
    applyTransactionEdit_(sheet, row, header, editValue, String(e.oldValue ?? ''), {
      showSuccessToast: true,
    });
  } catch (error) {
    rollbackFailedEdit_(sheet, row, header, String(e.oldValue ?? ''));
    handleAutomaticEditError_(sheet, row, error);
  }
}

function applyTransactionEdit_(sheet, rowNumber, header, rawValue, oldRawValue, saveOptions) {
  const accountOptions = loadAccountOptions_();
  let precomputed;
  if (header === 'split_off_amount') {
    const splitValue = String(rawValue ?? '').trim();
    if (!splitValue) return;
    precomputed = performSplitInstructionForRow_(sheet, rowNumber, splitValue);
  } else if (header === 'amount') {
    precomputed = handleAmountEdit_(sheet, rowNumber, rawValue, oldRawValue);
  } else if (header === 'payee') {
    precomputed = propagateTransactionField_(sheet, rowNumber, header, String(rawValue || ''));
  } else if (header === 'narration') {
    precomputed = applyNarrationEdit_(sheet, rowNumber, String(rawValue || ''));
  } else {
    precomputed = findTransactionRowNumbersFromAnchor_(sheet, rowNumber);
  }

  if (!precomputed) return;
  const context = buildTransactionContext_(accountOptions);
  const entity = Transaction.fromRows(precomputed.rows, context, precomputed.span);
  SpreadsheetApp.getActiveSpreadsheet().toast('Saving transaction…', 'Family Ledger', 60);
  try {
    entity.save(sheet);
  } catch (error) {
    SpreadsheetApp.getActiveSpreadsheet().toast(error.message || String(error), 'Family Ledger', 5);
    return;
  }
  try {
    refreshDoctorIssueSheets_(context.accountResourceToDisplayName || {});
  } catch (_e) {}
  SpreadsheetApp.getActiveSpreadsheet().toast('Transaction saved.', 'Family Ledger', 3);
}

function performSplitForRow_(sheet, rowNumber, rawSplitAmount) {
  const { transactionName, rows: groupRows } = findTransactionRowNumbersFromAnchor_(sheet, rowNumber);
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
  const updatedRows = insertSplitRow_(sheet, rowNumber, row, groupRows, originalAmount - splitAmount, splitAmount, 'split_off_amount');
  return { span: { start: updatedRows[0].__rowNumber, count: updatedRows.length }, transactionName: transactionName, rows: updatedRows };
}

function insertSplitRow_(sheet, rowNumber, row, groupRows, rowAmount, splitAmount, focusHeader) {
  const newRow = Object.assign({}, row);
  newRow.amount = splitAmount;
  newRow.split_off_amount = '';
  newRow.narration_source = 'txn';
  newRow.narration = String(inferTransactionNarrationFromSiblingRows_(groupRows, rowNumber, row) || '');

  row.amount = rowAmount;
  row.split_off_amount = '';

  const txConfig = FAMILY_LEDGER_SHEET_REGISTRY.transactions;
  sheet.insertRowsAfter(rowNumber, 1);
  managedSheet_(sheet, txConfig).setRow(rowNumber, row);
  managedSheet_(sheet, txConfig).setRow(rowNumber + 1, newRow);
  applyAccountValidationToSpan_(sheet, { start: rowNumber + 1, count: 1 });
  managedSheet_(sheet, txConfig).activateCell(rowNumber + 1, focusHeader);

  return computePostInsertRows_(groupRows, rowNumber, row, newRow);
}

function computePostInsertRows_(groupRows, rowNumber, row, newRow) {
  const updatedRows = groupRows.map(function(r) {
    if (r.__rowNumber === rowNumber) return Object.assign({}, row, { __rowNumber: rowNumber });
    if (r.__rowNumber > rowNumber) return Object.assign({}, r, { __rowNumber: r.__rowNumber + 1 });
    return r;
  });
  const insertIndex = updatedRows.findIndex(function(r) { return r.__rowNumber === rowNumber; }) + 1;
  updatedRows.splice(insertIndex, 0, Object.assign({}, newRow, { __rowNumber: rowNumber + 1 }));
  return updatedRows;
}

function performSplitInstructionForRow_(sheet, rowNumber, instruction) {
  const normalizedInstruction = String(instruction ?? '').trim();
  if (!normalizedInstruction) {
    return;
  }
  if (normalizedInstruction === 'x' || normalizedInstruction === 'X' || normalizedInstruction === '-') {
    return performDeleteSplitRow_(sheet, rowNumber);
  }
  return performSplitForRow_(sheet, rowNumber, normalizedInstruction);
}

function performDeleteSplitRow_(sheet, rowNumber) {
  const { span, transactionName, rows: groupRows } = findTransactionRowNumbersFromAnchor_(sheet, rowNumber);
  const row = groupRows.find(function(r) { return r.__rowNumber === rowNumber; });
  if (!row || !row.resource_name) {
    throw new Error('The selected row does not contain a transaction.');
  }

  const txConfig = FAMILY_LEDGER_SHEET_REGISTRY.transactions;

  if (span.count <= 1) {
    row.destination_account_name = '';
    row.split_off_amount = '';
    row.narration_source = 'txn';
    managedSheet_(sheet, txConfig).setRow(rowNumber, row);
    managedSheet_(sheet, txConfig).activateCell(rowNumber, 'split_off_amount');
    return { span: { start: rowNumber, count: 1 }, transactionName: transactionName, rows: [row] };
  }

  const mergeTargetRowNumber = rowNumber > span.start ? rowNumber - 1 : rowNumber + 1;
  const mergeTarget = groupRows.find(function(r) { return r.__rowNumber === mergeTargetRowNumber; });
  mergeTarget.amount = mergeTarget.amount + row.amount;
  mergeTarget.split_off_amount = '';
  if (span.count === 2) {
    mergeTarget.narration_source = 'txn';
  }

  if (mergeTargetRowNumber < rowNumber) {
    managedSheet_(sheet, txConfig).setRow(mergeTargetRowNumber, mergeTarget);
    sheet.deleteRow(rowNumber);
    managedSheet_(sheet, txConfig).activateCell(mergeTargetRowNumber, 'split_off_amount');
  } else {
    sheet.deleteRow(rowNumber);
    managedSheet_(sheet, txConfig).setRow(mergeTargetRowNumber - 1, mergeTarget);
    managedSheet_(sheet, txConfig).activateCell(rowNumber, 'split_off_amount');
  }

  const survivingRows = groupRows
    .filter(function(r) { return r.__rowNumber !== rowNumber; })
    .map(function(r) {
      return r.__rowNumber > rowNumber
        ? Object.assign({}, r, { __rowNumber: r.__rowNumber - 1 })
        : r;
    });
  return {
    span: { start: span.start, count: span.count - 1 },
    transactionName: transactionName,
    rows: survivingRows,
  };
}

function handleAmountEdit_(sheet, rowNumber, rawValue, oldRawValue) {
  const precomputed = findTransactionRowNumbersFromAnchor_(sheet, rowNumber);
  const { span } = precomputed;
  const groupRows = precomputed.rows;
  const row = groupRows.find(function(r) { return r.__rowNumber === rowNumber; });

  if (groupRows.every(function(r) { return !String(r.destination_account_name || '').trim(); })) {
    restoreAmountCell_(sheet, rowNumber, normalizedFallbackAmount_(oldRawValue));
    throw new Error('Amount cannot be edited until a destination account is set.');
  }

  const oldAmount = parseFloat(oldRawValue);
  const newAmount = parseFloat(rawValue);
  if (isNaN(oldAmount)) {
    return { span: span, transactionName: precomputed.transactionName, rows: groupRows };
  }

  if (isNaN(newAmount)) {
    restoreAmountCell_(sheet, rowNumber, normalizedFallbackAmount_(oldRawValue));
    throw new Error('Invalid amount — enter a valid number.');
  }

  if (newAmount === oldAmount) {
    return { span: span, transactionName: precomputed.transactionName, rows: groupRows };
  }

  const updatedRows = insertSplitRow_(sheet, rowNumber, row, groupRows, newAmount, oldAmount - newAmount, 'amount');
  return {
    span: { start: updatedRows[0].__rowNumber, count: updatedRows.length },
    transactionName: precomputed.transactionName,
    rows: updatedRows,
  };
}

function restoreAmountCell_(sheet, rowNumber, amount) {
  managedSheet_(sheet, FAMILY_LEDGER_SHEET_REGISTRY.transactions).setFields({ start: rowNumber, count: 1 }, { amount: amount });
}

function rollbackFailedEdit_(sheet, rowNumber, header, oldValue) {
  if (header === 'amount') {
    restoreAmountCell_(sheet, rowNumber, normalizedFallbackAmount_(oldValue));
    return;
  }
  if (header === 'split_off_amount') {
    managedSheet_(sheet, FAMILY_LEDGER_SHEET_REGISTRY.transactions).setFields({ start: rowNumber, count: 1 }, { split_off_amount: '' });
  }
}

function normalizedFallbackAmount_(amount) {
  const n = parseFloat(amount);
  return isNaN(n) ? '' : n;
}

function propagateTransactionField_(sheet, rowNumber, header, value) {
  const { span, transactionName, rows } = findTransactionRowNumbersFromAnchor_(sheet, rowNumber);
  managedSheet_(sheet, FAMILY_LEDGER_SHEET_REGISTRY.transactions).setFields(span, { [header]: value });
  rows.forEach(function(row) { row[header] = value; });
  return { span: span, transactionName: transactionName, rows: rows };
}

function applyNarrationEdit_(sheet, rowNumber, value) {
  const { span, transactionName, rows } = findTransactionRowNumbersFromAnchor_(sheet, rowNumber);
  if (span.count <= 1) {
    const row = applySingleRowTransactionNarrationEdit_(sheet, rowNumber, rows[0], value);
    return { span: span, transactionName: transactionName, rows: [row] };
  }

  const groupRows = applySplitRowPostingNarrationEdit_(sheet, rowNumber, rows, value);
  return { span: span, transactionName: transactionName, rows: groupRows };
}

function applySingleRowTransactionNarrationEdit_(sheet, rowNumber, row, value) {
  row.narration_source = 'txn';
  row.narration = value;
  managedSheet_(sheet, FAMILY_LEDGER_SHEET_REGISTRY.transactions).setRow(rowNumber, row);
  return row;
}

function applySplitRowPostingNarrationEdit_(sheet, rowNumber, groupRows, value) {
  const row = groupRows.find(function(r) { return r.__rowNumber === rowNumber; });
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

  managedSheet_(sheet, FAMILY_LEDGER_SHEET_REGISTRY.transactions).setRow(rowNumber, row);
  return groupRows;
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

function openEditTransactionSidebar_(sheet, rowNumber) {
  managedSheet_(sheet, FAMILY_LEDGER_SHEET_REGISTRY.transactions).setFields({ start: rowNumber, count: 1 }, { edit: false });
  let transactionName;
  try {
    transactionName = findTransactionRowNumbersFromAnchor_(sheet, rowNumber).transactionName;
  } catch (_e) {
    SpreadsheetApp.getUi().alert(
      'Edit Transaction',
      'The selected row does not contain a transaction.',
      SpreadsheetApp.getUi().ButtonSet.OK
    );
    return;
  }
  const template = HtmlService.createTemplateFromFile('QuickAddTransactionSidebar');
  template.transactionName = transactionName;
  template.anchorRow = rowNumber;
  SpreadsheetApp.getUi().showSidebar(template.evaluate().setTitle('Edit Transaction'));
}

function handleAutomaticEditError_(sheet, rowNumber, error) {
  SpreadsheetApp.getActiveSpreadsheet().toast(error.message || String(error), 'Family Ledger', 5);
}
