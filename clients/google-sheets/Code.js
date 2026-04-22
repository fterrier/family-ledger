const FAMILY_LEDGER_SHEET_NAMES = {
  accounts: 'Accounts',
  transactions: 'Transactions',
};

const FAMILY_LEDGER_PAGE_SIZE = 1000;

const FAMILY_LEDGER_TRANSACTION_HEADERS = [
  'transaction_name',
  'transaction_date',
  'payee',
  'narration',
  'source_account_name',
  'destination_account_name',
  'symbol',
  'amount',
  'split_off_amount',
  'status',
  'last_error',
];

const FAMILY_LEDGER_ACCOUNTS_HEADERS = ['account_name', 'name'];

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Family Ledger')
    .addItem('Set API Base URL', 'setFamilyLedgerBaseUrl')
    .addItem('Set API Token', 'setFamilyLedgerApiToken')
    .addItem('Show Current Settings', 'showFamilyLedgerSettings')
    .addItem('Test Connection', 'testFamilyLedgerConnection')
    .addSeparator()
    .addItem('Sync Accounts', 'syncFamilyLedgerAccounts')
    .addItem('Sync Transactions', 'syncFamilyLedgerTransactions')
    .addSeparator()
    .addItem('Push Active Transaction', 'pushActiveTransaction')
    .addToUi();
}

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

  const header = FAMILY_LEDGER_TRANSACTION_HEADERS[column - 1];
  if (
    header !== 'payee' &&
    header !== 'narration' &&
    header !== 'destination_account_name' &&
    header !== 'amount' &&
    header !== 'split_off_amount'
  ) {
    return;
  }

  const transactionName = getTransactionNameForRow_(sheet, row);
  if (!transactionName) {
    return;
  }

  try {
    applyTransactionEdit_(sheet, row, header, String(e.range.getValue() || ''), String(e.oldValue || ''), {
      showSuccessToast: true,
    });
  } catch (error) {
    handleAutomaticEditError_(sheet, transactionName, error);
  }
}

function applyTransactionEdit_(sheet, rowNumber, header, rawValue, oldRawValue, saveOptions) {
  const transactionName = getTransactionNameForRow_(sheet, rowNumber);
  if (!transactionName) {
    return;
  }

  if (header === 'split_off_amount') {
    const splitValue = String(rawValue || '').trim();
    if (!splitValue) {
      return;
    }
    performSplitInstructionForRow_(sheet, rowNumber, splitValue);
  } else if (header === 'payee' || header === 'narration') {
    propagateTransactionField_(sheet, transactionName, header, String(rawValue || ''));
  } else if (header === 'amount') {
    handleAmountEdit_(sheet, rowNumber, rawValue, oldRawValue);
  } else {
    clearTransactionErrors_(sheet, transactionName);
  }

  saveTransactionByName_(sheet, transactionName, saveOptions || {});
}

function setFamilyLedgerBaseUrl() {
  runUserAction_('Set API Base URL', function() {
    const ui = SpreadsheetApp.getUi();
    const currentValue = getFamilyLedgerBaseUrl_();
    const response = ui.prompt(
      'Family Ledger API Base URL',
      currentValue || 'http://localhost:8000',
      ui.ButtonSet.OK_CANCEL
    );

    if (response.getSelectedButton() !== ui.Button.OK) {
      return;
    }

    const baseUrl = normalizeBaseUrl_(response.getResponseText());
    PropertiesService.getScriptProperties().setProperty('FAMILY_LEDGER_BASE_URL', baseUrl);
    ui.alert('Saved API base URL: ' + baseUrl);
  });
}

function setFamilyLedgerApiToken() {
  runUserAction_('Set API Token', function() {
    const ui = SpreadsheetApp.getUi();
    const response = ui.prompt(
      'Family Ledger API Token',
      'Paste the bearer token configured on the server.',
      ui.ButtonSet.OK_CANCEL
    );

    if (response.getSelectedButton() !== ui.Button.OK) {
      return;
    }

    const token = normalizeApiToken_(response.getResponseText());
    PropertiesService.getScriptProperties().setProperty('FAMILY_LEDGER_API_TOKEN', token);
    ui.alert('Saved API token.');
  });
}

function showFamilyLedgerSettings() {
  runUserAction_('Show Current Settings', function() {
    const ui = SpreadsheetApp.getUi();
    const baseUrl = getFamilyLedgerBaseUrl_();
    const apiToken = getFamilyLedgerApiToken_();
    ui.alert(
      'Family Ledger Settings',
      'Base URL: ' + (baseUrl || '(not set)') + '\n' +
        'API token: ' + (apiToken ? maskToken_(apiToken) : '(not set)'),
      ui.ButtonSet.OK
    );
  });
}

function testFamilyLedgerConnection() {
  runUserAction_('Test Connection', function() {
    const ui = SpreadsheetApp.getUi();
    const baseUrl = getFamilyLedgerBaseUrl_();
    const apiToken = getFamilyLedgerApiToken_();
    if (!baseUrl) {
      throw new Error('Missing FAMILY_LEDGER_BASE_URL. Run Set API Base URL first.');
    }
    if (!apiToken) {
      throw new Error('Missing FAMILY_LEDGER_API_TOKEN. Run Set API Token first.');
    }

    let healthMessage = 'not checked';
    let authMessage = 'not checked';

    try {
      const health = apiFetchJson_('get', '/healthz', undefined, { skipAuth: true });
      healthMessage = health.status === 'ok' ? 'ok' : 'unexpected response';
    } catch (error) {
      healthMessage = error.message;
    }

    if (healthMessage === 'ok') {
      try {
        apiFetchJson_('get', '/accounts?page_size=1');
        authMessage = 'ok';
      } catch (error) {
        authMessage = error.message;
      }
    }

    ui.alert(
      'Family Ledger Connection Test',
      'Health: ' + healthMessage + '\n' + 'Ledger auth: ' + authMessage,
      ui.ButtonSet.OK
    );
  });
}

function syncFamilyLedgerAccounts() {
  runUserAction_('Sync Accounts', function() {
    ensureEditTriggerInstalled_();
    const accounts = fetchFamilyLedgerPagedResource_(
      '/accounts?page_size=' + FAMILY_LEDGER_PAGE_SIZE,
      'accounts'
    );
    accounts.sort(function(a, b) {
      return a.account_name.localeCompare(b.account_name);
    });

    const sheet = getOrCreateSheet_(FAMILY_LEDGER_SHEET_NAMES.accounts);
    const rows = accounts.map(function(account) {
      return [account.account_name, account.name];
    });

    writeSheet_(sheet, FAMILY_LEDGER_ACCOUNTS_HEADERS, rows);
    sheet.setFrozenRows(1);
    SpreadsheetApp.getUi().alert(
      'Account Sync Complete',
      'Synced ' + accounts.length + ' accounts.',
      SpreadsheetApp.getUi().ButtonSet.OK
    );
  });
}

function syncFamilyLedgerTransactions() {
  runUserAction_('Sync Transactions', function() {
    ensureEditTriggerInstalled_();
    const accountNameLookup = loadAccountsFromApi_();
    const transactions = fetchFamilyLedgerPagedResource_(
      '/transactions?page_size=' + FAMILY_LEDGER_PAGE_SIZE,
      'transactions'
    );
    const rows = [];
    const skippedExamples = [];
    let skippedCount = 0;

    transactions.forEach(function(transaction) {
      const renderedRows = flattenTransactionForSheet_(transaction, accountNameLookup);
      if (renderedRows === null) {
        skippedCount += 1;
        if (skippedExamples.length < 10) {
          skippedExamples.push(describeTransactionForSyncSkip_(transaction));
        }
        return;
      }
      renderedRows.forEach(function(row) {
        rows.push(row);
      });
    });

    const sheet = getOrCreateSheet_(FAMILY_LEDGER_SHEET_NAMES.transactions);
    setTransactionSheetRows_(sheet, rows);

    SpreadsheetApp.getUi().alert(
      'Transaction Sync Complete',
      buildTransactionSyncSummaryMessage_(transactions.length, rows.length, skippedCount, skippedExamples),
      SpreadsheetApp.getUi().ButtonSet.OK
    );
  });
}

function splitSelectedTransactionRow() {
  runUserAction_('Split Selected Row', function() {
    const sheet = requireTransactionSheet_();
    const activeRow = sheet.getActiveRange().getRow();
    if (activeRow <= 1) {
      throw new Error('Select a transaction data row before splitting.');
    }

    const row = readTransactionSheetRow_(sheet, activeRow);
    if (!row || !row.transaction_name) {
      throw new Error('The selected row does not contain a transaction.');
    }

    const ui = SpreadsheetApp.getUi();
    const response = ui.prompt(
      'Split Selected Row',
      'Enter the amount to split off from the selected row.',
      ui.ButtonSet.OK_CANCEL
    );
    if (response.getSelectedButton() !== ui.Button.OK) {
      return;
    }
    applyTransactionEdit_(sheet, activeRow, 'split_off_amount', response.getResponseText(), '', {
      showSuccessToast: true,
    });
  });
}

function normalizeActiveTransactionFields() {
  runUserAction_('Normalize Active Transaction Fields', function() {
    const sheet = requireTransactionSheet_();
    const group = getActiveTransactionGroupFromSheet_(sheet);
    const activeRow = group.rows[group.activeIndex];
    propagateTransactionField_(sheet, group.transactionName, 'payee', String(activeRow.payee || ''));
    propagateTransactionField_(sheet, group.transactionName, 'narration', String(activeRow.narration || ''));
  });
}

function regroupActiveTransaction() {
  runUserAction_('Regroup Active Transaction', function() {
    const sheet = requireTransactionSheet_();
    const group = getActiveTransactionGroupFromSheet_(sheet);
    if (group.contiguous) {
      return;
    }
    replaceTransactionRowsInSheet_(sheet, group.rowNumbers, group.rows);
  });
}

function pushActiveTransaction() {
  runUserAction_('Push Active Transaction', function() {
    const sheet = requireTransactionSheet_();
    const group = getActiveTransactionGroupFromSheet_(sheet);
    saveTransactionByName_(sheet, group.transactionName, { showSuccessAlert: true });
  });
}

function runUserAction_(actionName, fn) {
  try {
    return fn();
  } catch (error) {
    reportUserError_(actionName, error);
    return null;
  }
}

function reportUserError_(actionName, error) {
  const message = error && error.message ? error.message : String(error);
  SpreadsheetApp.getUi().alert(actionName + ' Failed', message, SpreadsheetApp.getUi().ButtonSet.OK);
}

function ensureEditTriggerInstalled_() {
  const spreadsheetId = SpreadsheetApp.getActiveSpreadsheet().getId();
  const existing = ScriptApp.getProjectTriggers().some(function(trigger) {
    return (
      trigger.getHandlerFunction() === 'handleTransactionEdit' &&
      trigger.getTriggerSourceId &&
      trigger.getTriggerSourceId() === spreadsheetId
    );
  });
  if (!existing) {
    ScriptApp.newTrigger('handleTransactionEdit')
      .forSpreadsheet(spreadsheetId)
      .onEdit()
      .create();
  }
}

function performSplitForRow_(sheet, rowNumber, rawSplitAmount) {
  const row = readTransactionSheetRow_(sheet, rowNumber);
  if (!row || !row.transaction_name) {
    throw new Error('The selected row does not contain a transaction.');
  }

  const splitAmount = normalizeDecimalString_(rawSplitAmount);
  const originalAmount = normalizeDecimalString_(row.amount);
  if (compareDecimalStrings_(splitAmount, '0') <= 0) {
    throw new Error('Split amount must be greater than zero.');
  }
  if (compareDecimalStrings_(splitAmount, originalAmount) >= 0) {
    throw new Error('Split amount must be less than the selected row amount.');
  }

  const newRow = cloneTransactionSheetRow_(row);
  newRow.amount = splitAmount;
  newRow.split_off_amount = '';
  newRow.status = 'dirty';
  newRow.last_error = '';

  row.amount = subtractDecimalStrings_(originalAmount, splitAmount);
  row.split_off_amount = '';
  row.status = 'dirty';
  row.last_error = '';

  sheet.insertRowsAfter(rowNumber, 1);
  writeTransactionSheetRow_(sheet, rowNumber, row);
  writeTransactionSheetRow_(sheet, rowNumber + 1, newRow);
  applyAccountValidationToRowNumbers_(sheet, [rowNumber + 1]);
  focusNewSplitRow_(sheet, rowNumber + 1);
}

function performSplitFromEditedAmount_(sheet, rowNumber, oldAmountRaw, newAmountRaw) {
  const row = readTransactionSheetRow_(sheet, rowNumber);
  if (!row || !row.transaction_name) {
    throw new Error('The selected row does not contain a transaction.');
  }

  const oldAmount = normalizeDecimalString_(oldAmountRaw);
  const newAmount = normalizeDecimalString_(newAmountRaw);
  if (compareDecimalStrings_(newAmount, '0') <= 0) {
    throw new Error('Imported transaction allocation amounts must be greater than zero.');
  }
  if (compareDecimalStrings_(newAmount, oldAmount) >= 0) {
    throw new Error(
      'Imported transaction totals are fixed. Reduce an amount to split it; direct increases are not allowed.'
    );
  }

  const splitAmount = subtractDecimalStrings_(oldAmount, newAmount);
  const newRow = cloneTransactionSheetRow_(row);
  newRow.amount = splitAmount;
  newRow.split_off_amount = '';
  newRow.status = 'dirty';
  newRow.last_error = '';

  row.amount = newAmount;
  row.split_off_amount = '';
  row.status = 'dirty';
  row.last_error = '';

  sheet.insertRowsAfter(rowNumber, 1);
  writeTransactionSheetRow_(sheet, rowNumber, row);
  writeTransactionSheetRow_(sheet, rowNumber + 1, newRow);
  applyAccountValidationToRowNumbers_(sheet, [rowNumber + 1]);
  focusNewSplitRow_(sheet, rowNumber + 1);
}

function focusNewSplitRow_(sheet, rowNumber) {
  sheet.getRange(rowNumber, getTransactionHeaderColumnIndex_('split_off_amount')).activate();
}

function performSplitInstructionForRow_(sheet, rowNumber, instruction) {
  const normalizedInstruction = String(instruction || '').trim();
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
  const row = readTransactionSheetRow_(sheet, rowNumber);
  if (!row || !row.transaction_name) {
    throw new Error('The selected row does not contain a transaction.');
  }

  const rowNumbers = findTransactionRowNumbers_(sheet, row.transaction_name);
  if (rowNumbers.length <= 1) {
    throw new Error('Cannot delete the only allocation row for this transaction.');
  }

  const currentIndex = rowNumbers.indexOf(rowNumber);
  const mergeTargetRowNumber = currentIndex > 0 ? rowNumbers[currentIndex - 1] : rowNumbers[currentIndex + 1];
  const mergeTarget = readTransactionSheetRow_(sheet, mergeTargetRowNumber);
  const mergedAmount = sumDecimalStrings_([
    normalizeDecimalString_(mergeTarget.amount),
    normalizeDecimalString_(row.amount),
  ]);

  mergeTarget.amount = mergedAmount;
  mergeTarget.split_off_amount = '';
  mergeTarget.status = 'dirty';
  mergeTarget.last_error = '';

  if (mergeTargetRowNumber < rowNumber) {
    writeTransactionSheetRow_(sheet, mergeTargetRowNumber, mergeTarget);
    sheet.deleteRow(rowNumber);
  } else {
    sheet.deleteRow(rowNumber);
    writeTransactionSheetRow_(sheet, mergeTargetRowNumber - 1, mergeTarget);
  }
}

function handleAmountEdit_(sheet, rowNumber, rawValue, oldRawValue) {
  const oldAmount = String(oldRawValue || '').trim();
  const newAmount = String(rawValue || '').trim();
  if (!oldAmount) {
    clearTransactionErrors_(sheet, getTransactionNameForRow_(sheet, rowNumber));
    return;
  }

  let normalizedOldAmount;
  let normalizedNewAmount;
  try {
    normalizedOldAmount = normalizeDecimalString_(oldAmount);
    normalizedNewAmount = normalizeDecimalString_(newAmount);
  } catch {
    restoreAmountCell_(sheet, rowNumber, normalizedFallbackAmount_(oldAmount));
    throw new Error(
      'Imported transaction totals are fixed. Reduce an amount to split it; direct increases are not allowed.'
    );
  }

  const comparison = compareDecimalStrings_(normalizedNewAmount, normalizedOldAmount);
  if (comparison === 0) {
    clearTransactionErrors_(sheet, getTransactionNameForRow_(sheet, rowNumber));
    return;
  }
  if (comparison > 0) {
    restoreAmountCell_(sheet, rowNumber, normalizedOldAmount);
    throw new Error(
      'Imported transaction totals are fixed. Reduce an amount to split it; direct increases are not allowed.'
    );
  }

  performSplitFromEditedAmount_(sheet, rowNumber, normalizedOldAmount, normalizedNewAmount);
}

function restoreAmountCell_(sheet, rowNumber, amount) {
  sheet.getRange(rowNumber, getTransactionHeaderColumnIndex_('amount')).setValue(amount);
}

function normalizedFallbackAmount_(amount) {
  try {
    return normalizeDecimalString_(amount);
  } catch {
    return amount;
  }
}

function propagateTransactionField_(sheet, transactionName, header, value) {
  // TODO: Improve payee and narration UX so grouped transaction-level fields are clearer to edit in-sheet.
  const rowNumbers = findTransactionRowNumbers_(sheet, transactionName);
  setFieldValuesForRowNumbers_(sheet, rowNumbers, header, value);
  setFieldValuesForRowNumbers_(sheet, rowNumbers, 'status', 'dirty');
  setFieldValuesForRowNumbers_(sheet, rowNumbers, 'last_error', '');
}

function clearTransactionErrors_(sheet, transactionName) {
  const rowNumbers = findTransactionRowNumbers_(sheet, transactionName);
  setFieldValuesForRowNumbers_(sheet, rowNumbers, 'status', 'dirty');
  setFieldValuesForRowNumbers_(sheet, rowNumbers, 'last_error', '');
}

function handleAutomaticEditError_(sheet, transactionName, error) {
  setFieldValuesForRowNumbers_(sheet, findTransactionRowNumbers_(sheet, transactionName), 'status', 'error');
  setFieldValuesForRowNumbers_(sheet, findTransactionRowNumbers_(sheet, transactionName), 'last_error', error.message || String(error));
  SpreadsheetApp.getActiveSpreadsheet().toast(error.message || String(error), 'Family Ledger', 5);
}

function saveTransactionByName_(sheet, transactionName, options) {
  options = options || {};
  const rowNumbers = findTransactionRowNumbers_(sheet, transactionName);
  const rows = readTransactionSheetRowsByNumbers_(sheet, rowNumbers);
  const saveGeneration = beginSaveGeneration_(transactionName);
  const group = {
    transactionName: transactionName,
    activeIndex: 0,
    rowNumbers: rowNumbers,
    rows: rows,
    contiguous: isContiguousRowNumbers_(rowNumbers),
  };

  setFieldValuesForRowNumbers_(sheet, rowNumbers, 'status', 'saving');
  setFieldValuesForRowNumbers_(sheet, rowNumbers, 'last_error', '');

  try {
    const accountNameMap = loadAccountNameMap_();
    const payload = buildTransactionPatchPayloadFromGroup_(group, accountNameMap);
    apiFetchJson_('patch', '/' + transactionName, {
      transaction: payload,
      update_mask: 'payee,narration,postings',
    });

    const refreshed = apiFetchJson_('get', '/' + transactionName);
    const accountNameLookup = loadAccountsFromApi_();
    const replacementRows = flattenTransactionForSheet_(refreshed, accountNameLookup);
    if (replacementRows === null) {
      throw new Error('The updated transaction is no longer editable in this Sheets client.');
    }
    if (!isCurrentSaveGeneration_(transactionName, saveGeneration)) {
      return;
    }
    replacementRows.forEach(function(row) {
      row.split_off_amount = '';
      row.status = 'saved';
      row.last_error = '';
    });
    if (areTransactionRowsEquivalentForRefresh_(rows, replacementRows)) {
      setFieldValuesForRowNumbers_(sheet, rowNumbers, 'status', 'saved');
      setFieldValuesForRowNumbers_(sheet, rowNumbers, 'last_error', '');
    } else if (canUpdateTransactionRowsInPlace_(rows, replacementRows)) {
      updateTransactionRowsInPlace_(sheet, rowNumbers, rows, replacementRows);
    } else {
      replaceTransactionRowsInSheet_(sheet, rowNumbers, replacementRows);
    }

    if (options.showSuccessAlert) {
      SpreadsheetApp.getUi().alert(
        'Transaction Updated',
        'Successfully pushed the active transaction.',
        SpreadsheetApp.getUi().ButtonSet.OK
      );
    }
    if (options.showSuccessToast) {
      SpreadsheetApp.getActiveSpreadsheet().toast('Saved transaction', 'Family Ledger', 3);
    }
  } catch (error) {
    if (isCurrentSaveGeneration_(transactionName, saveGeneration)) {
      setFieldValuesForRowNumbers_(sheet, rowNumbers, 'status', 'error');
      setFieldValuesForRowNumbers_(sheet, rowNumbers, 'last_error', error.message || String(error));
    }
    if (options.showSuccessAlert) {
      throw error;
    }
  }
}

function beginSaveGeneration_(transactionName) {
  const properties = PropertiesService.getDocumentProperties();
  const key = getSaveGenerationKey_(transactionName);
  const currentValue = parseInt(properties.getProperty(key) || '0', 10);
  const nextValue = String(currentValue + 1);
  properties.setProperty(key, nextValue);
  return nextValue;
}

function isCurrentSaveGeneration_(transactionName, generation) {
  return PropertiesService.getDocumentProperties().getProperty(getSaveGenerationKey_(transactionName)) === generation;
}

function getSaveGenerationKey_(transactionName) {
  return 'family_ledger_save_generation:' + transactionName;
}

function flattenTransactionForSheet_(transaction, accountNameLookup) {
  const shape = classifySupportedTransaction_(transaction);
  if (shape === null) {
    return null;
  }

  const sourcePosting = transaction.postings[shape.sourceIndex];
  const sourceAccountName = accountNameLookup[sourcePosting.account] || sourcePosting.account;

  return shape.destinationIndexes.map(function(destinationIndex) {
    const posting = transaction.postings[destinationIndex];
    return {
      transaction_name: transaction.name,
      transaction_date: transaction.transaction_date,
      payee: transaction.payee || '',
      narration: transaction.narration || '',
      source_account_name: sourceAccountName,
      destination_account_name: accountNameLookup[posting.account] || posting.account,
      amount: normalizeDecimalString_(posting.units.amount),
      split_off_amount: '',
      symbol: posting.units.symbol,
      status: '',
      last_error: '',
    };
  });
}

function classifySupportedTransaction_(transaction) {
  if (!transaction || !Array.isArray(transaction.postings) || transaction.postings.length < 2) {
    return null;
  }

  const postings = transaction.postings;
  let sourceIndex = null;
  let symbol = null;

  for (let index = 0; index < postings.length; index += 1) {
    const posting = postings[index];
    if (!posting.units || posting.cost || posting.price) {
      return null;
    }
    if (symbol === null) {
      symbol = posting.units.symbol;
    } else if (symbol !== posting.units.symbol) {
      return null;
    }

    const amount = normalizeDecimalString_(posting.units.amount);
    if (compareDecimalStrings_(amount, '0') < 0) {
      if (sourceIndex !== null) {
        return null;
      }
      sourceIndex = index;
    }
  }

  if (sourceIndex === null) {
    return null;
  }

  const destinationIndexes = [];
  for (let index = 0; index < postings.length; index += 1) {
    if (index === sourceIndex) {
      continue;
    }
    const amount = normalizeDecimalString_(postings[index].units.amount);
    if (compareDecimalStrings_(amount, '0') <= 0) {
      return null;
    }
    destinationIndexes.push(index);
  }

  if (destinationIndexes.length === 0) {
    return null;
  }

  return {
    sourceIndex: sourceIndex,
    destinationIndexes: destinationIndexes,
    symbol: symbol,
  };
}

function describeTransactionForSyncSkip_(transaction) {
  const date = transaction.transaction_date || '(missing date)';
  const payee = transaction.payee || '';
  const narration = transaction.narration || '';
  const postingCount = Array.isArray(transaction.postings) ? transaction.postings.length : 0;
  return date + ' | ' + payee + ' | ' + narration + ' | postings=' + postingCount;
}

function buildTransactionSyncSummaryMessage_(totalCount, syncedRowCount, skippedCount, skippedExamples) {
  let message =
    'Fetched ' + totalCount + ' transactions from the server.\n' +
    'Synced ' + syncedRowCount + ' allocation rows into the sheet.\n' +
    'Skipped ' + skippedCount + ' transactions that are not currently editable in this client.';

  if (skippedExamples && skippedExamples.length > 0) {
    message += '\n\nExamples of skipped transactions:\n- ' + skippedExamples.join('\n- ');
  }

  return message;
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
      sheet.getRange(rowNumber, getTransactionHeaderColumnIndex_(header)).setValue(replacementRow[header] || '');
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
  };
}

function normalizeSheetCellValue_(value) {
  if (Object.prototype.toString.call(value) === '[object Date]') {
    return normalizeTransactionDate_(value);
  }
  return String(value || '');
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
}

function materializeTransactionSheetRow_(row) {
  return FAMILY_LEDGER_TRANSACTION_HEADERS.map(function(header) {
    return row[header] || '';
  });
}

function setTransactionSheetRows_(sheet, rows) {
  const materializedRows = rows.map(materializeTransactionSheetRow_);
  writeSheet_(sheet, FAMILY_LEDGER_TRANSACTION_HEADERS, materializedRows);
  sheet.setFrozenRows(1);
  applyAccountValidation_(sheet, materializedRows.length);
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
  const narration = readOptionalNormalizedValue_(group.rows, 'narration', 'narration', issues);
  const sourceAccount = resolveAccountResourceName_(accountNameMap, sourceAccountName);
  const destinationRows = [];
  const amounts = [];

  group.rows.forEach(function(row, index) {
    const displayRow = row.__rowNumber || index + 2;
    const destinationAccountName = String(row.destination_account_name || '').trim();
    if (!destinationAccountName) {
      issues.push('Row ' + displayRow + ': destination_account_name is required.');
      return;
    }

    let amount;
    try {
      amount = normalizeDecimalString_(row.amount);
    } catch (error) {
      issues.push('Row ' + displayRow + ': ' + error.message);
      return;
    }
    if (compareDecimalStrings_(amount, '0') <= 0) {
      issues.push('Row ' + displayRow + ': amount must be greater than zero.');
      return;
    }

    destinationRows.push({
      account: resolveAccountResourceName_(accountNameMap, destinationAccountName),
      amount: amount,
    });
    amounts.push(amount);
  });

  if (destinationRows.length === 0) {
    issues.push('The transaction must have at least one destination row.');
  }
  if (!group.contiguous) {
    issues.push('Rows for this transaction are not contiguous. You can still push, but Regroup Active Transaction is recommended.');
  }

  if (issues.length > 0) {
    throw new Error(issues.join('\n'));
  }

  const totalAmount = sumDecimalStrings_(amounts);
  return {
    transaction_date: transactionDate,
    payee: payee,
    narration: narration,
    postings: [{
      account: sourceAccount,
      units: {
        amount: negateDecimalString_(totalAmount),
        symbol: symbol,
      },
    }].concat(destinationRows.map(function(row) {
      return {
        account: row.account,
        units: {
          amount: row.amount,
          symbol: symbol,
        },
      };
    })),
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

function loadAccountNameMap_() {
  const accountsSheet = getOrCreateSheet_(FAMILY_LEDGER_SHEET_NAMES.accounts);
  const lastRow = accountsSheet.getLastRow();
  const mapping = {};
  if (lastRow <= 1) {
    throw new Error('Accounts sheet is empty. Run Sync Accounts first.');
  }

  const rows = accountsSheet.getRange(2, 1, lastRow - 1, 2).getValues();
  rows.forEach(function(row) {
    if (row[0] && row[1]) {
      mapping[String(row[0])] = String(row[1]);
    }
  });
  return mapping;
}

function resolveAccountResourceName_(accountNameMap, accountName) {
  const resourceName = accountNameMap[accountName];
  if (!resourceName) {
    throw new Error('Unknown account_name: ' + accountName);
  }
  return resourceName;
}

function applyAccountValidation_(sheet, rowCount) {
  // TODO: Improve account UX beyond dropdown validation, especially for large account lists.
  if (rowCount === 0) {
    return;
  }

  const accountsSheet = getOrCreateSheet_(FAMILY_LEDGER_SHEET_NAMES.accounts);
  const lastRow = accountsSheet.getLastRow();
  if (lastRow <= 1) {
    return;
  }

  const rule = SpreadsheetApp.newDataValidation()
    .requireValueInRange(accountsSheet.getRange(2, 1, lastRow - 1, 1), true)
    .setAllowInvalid(false)
    .build();

  const destinationColumn = FAMILY_LEDGER_TRANSACTION_HEADERS.indexOf('destination_account_name') + 1;
  sheet.getRange(2, destinationColumn, rowCount, 1).setDataValidation(rule);
}

function applyAccountValidationToRowNumbers_(sheet, rowNumbers) {
  if (rowNumbers.length === 0) {
    return;
  }

  const accountsSheet = getOrCreateSheet_(FAMILY_LEDGER_SHEET_NAMES.accounts);
  const lastRow = accountsSheet.getLastRow();
  if (lastRow <= 1) {
    return;
  }

  const rule = SpreadsheetApp.newDataValidation()
    .requireValueInRange(accountsSheet.getRange(2, 1, lastRow - 1, 1), true)
    .setAllowInvalid(false)
    .build();

  const destinationColumn = getTransactionHeaderColumnIndex_('destination_account_name');
  rowNumbers.forEach(function(rowNumber) {
    sheet.getRange(rowNumber, destinationColumn).setDataValidation(rule);
  });
}

function getTransactionHeaderColumnIndex_(header) {
  return FAMILY_LEDGER_TRANSACTION_HEADERS.indexOf(header) + 1;
}

function fetchFamilyLedgerPagedResource_(path, resourceKey) {
  let nextPath = path;
  const items = [];

  while (nextPath) {
    const response = apiFetchJson_('get', nextPath);
    const pageItems = response[resourceKey] || [];
    pageItems.forEach(function(item) {
      items.push(item);
    });
    nextPath = response.next_page_token
      ? pathWithUpdatedPageToken_(nextPath, response.next_page_token)
      : null;
  }

  return items;
}

function loadAccountsFromApi_() {
  const accounts = fetchFamilyLedgerPagedResource_(
    '/accounts?page_size=' + FAMILY_LEDGER_PAGE_SIZE,
    'accounts'
  );
  const lookup = {};
  accounts.forEach(function(account) {
    lookup[account.name] = account.account_name;
  });
  return lookup;
}

function pathWithUpdatedPageToken_(path, pageToken) {
  const parts = path.split('?');
  const basePath = parts[0];
  const query = parts[1] || '';
  const filtered = query
    .split('&')
    .filter(function(part) {
      return part && part.indexOf('page_token=') !== 0;
    });
  filtered.push('page_token=' + encodeURIComponent(pageToken));
  return basePath + '?' + filtered.join('&');
}

function apiFetchJson_(method, path, payload, options) {
  options = options || {};
  const url = buildApiUrl_(path);
  const requestOptions = {
    method: method,
    contentType: 'application/json',
    muteHttpExceptions: true,
  };

  if (payload !== undefined) {
    requestOptions.payload = JSON.stringify(payload);
  }

  if (!options.skipAuth) {
    requestOptions.headers = {
      Authorization: 'Bearer ' + getRequiredFamilyLedgerApiToken_(),
    };
  }

  const response = UrlFetchApp.fetch(url, requestOptions);
  const statusCode = response.getResponseCode();
  const body = response.getContentText();

  if (statusCode >= 400) {
    throw buildApiError_(statusCode, body);
  }

  return body ? JSON.parse(body) : {};
}

function buildApiError_(statusCode, body) {
  if (!body) {
    return new Error('API request failed with status ' + statusCode + '.');
  }

  try {
    const parsed = JSON.parse(body);
    if (parsed.detail && parsed.detail.message) {
      return new Error(parsed.detail.code + ': ' + parsed.detail.message);
    }
  } catch {
    // Fall through to the raw body error below.
  }

  return new Error('API request failed with status ' + statusCode + ': ' + body);
}

function buildApiUrl_(path) {
  const baseUrl = getFamilyLedgerBaseUrl_();
  if (!baseUrl) {
    throw new Error('Missing FAMILY_LEDGER_BASE_URL script property.');
  }
  if (path.charAt(0) === '/') {
    return baseUrl + path;
  }
  return baseUrl + '/' + path;
}

function getFamilyLedgerBaseUrl_() {
  return PropertiesService.getScriptProperties().getProperty('FAMILY_LEDGER_BASE_URL');
}

function getFamilyLedgerApiToken_() {
  return PropertiesService.getScriptProperties().getProperty('FAMILY_LEDGER_API_TOKEN');
}

function getRequiredFamilyLedgerApiToken_() {
  const token = getFamilyLedgerApiToken_();
  if (!token) {
    throw new Error('Missing FAMILY_LEDGER_API_TOKEN. Run Set API Token first.');
  }
  return token;
}

function normalizeBaseUrl_(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    throw new Error('API base URL cannot be blank.');
  }
  return trimmed.replace(/\/+$/, '');
}

function normalizeApiToken_(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    throw new Error('API token cannot be blank.');
  }
  return trimmed;
}

function normalizeTransactionDate_(value) {
  if (Object.prototype.toString.call(value) === '[object Date]') {
    return Utilities.formatDate(value, 'UTC', 'yyyy-MM-dd');
  }
  return String(value || '').trim();
}

function getOrCreateSheet_(sheetName) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(sheetName);
  }
  return sheet;
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
  sheet.hideColumns(transactionNameColumn);
}

function rowToObject_(headers, rowValues) {
  const result = {};
  headers.forEach(function(header, index) {
    result[header] = rowValues[index];
  });
  return result;
}

function maskToken_(token) {
  if (token.length <= 8) {
    return '********';
  }
  return token.slice(0, 4) + '...' + token.slice(-4);
}

function normalizeDecimalString_(value) {
  const text = String(value || '').trim();
  if (!/^[-+]?\d+(\.\d+)?$/.test(text)) {
    throw new Error('Invalid decimal amount: ' + value);
  }

  let sign = '';
  let unsigned = text;
  if (unsigned.charAt(0) === '+' || unsigned.charAt(0) === '-') {
    sign = unsigned.charAt(0) === '-' ? '-' : '';
    unsigned = unsigned.slice(1);
  }

  const parts = unsigned.split('.');
  const integerPart = parts[0].replace(/^0+(?=\d)/, '') || '0';
  const fractionalPart = parts[1] ? parts[1].replace(/0+$/, '') : '';
  if (!fractionalPart) {
    return sign + integerPart;
  }
  return sign + integerPart + '.' + fractionalPart;
}

function sumDecimalStrings_(values) {
  const normalized = values.map(function(value) {
    return normalizeDecimalString_(value);
  });
  let scale = 0;
  normalized.forEach(function(value) {
    const parts = value.replace(/^[-+]/, '').split('.');
    const fractional = parts[1] || '';
    if (fractional.length > scale) {
      scale = fractional.length;
    }
  });

  let total = BigInt(0);
  normalized.forEach(function(value) {
    total += decimalStringToBigInt_(value, scale);
  });
  return bigIntToDecimalString_(total, scale);
}

function subtractDecimalStrings_(left, right) {
  const scale = Math.max(decimalScale_(left), decimalScale_(right));
  const result = decimalStringToBigInt_(left, scale) - decimalStringToBigInt_(right, scale);
  return bigIntToDecimalString_(result, scale);
}

function compareDecimalStrings_(left, right) {
  const scale = Math.max(decimalScale_(left), decimalScale_(right));
  const leftValue = decimalStringToBigInt_(left, scale);
  const rightValue = decimalStringToBigInt_(right, scale);
  if (leftValue < rightValue) {
    return -1;
  }
  if (leftValue > rightValue) {
    return 1;
  }
  return 0;
}

function negateDecimalString_(value) {
  const normalized = normalizeDecimalString_(value);
  if (normalized === '0') {
    return '0';
  }
  if (normalized.charAt(0) === '-') {
    return normalized.slice(1);
  }
  return '-' + normalized;
}

function decimalScale_(value) {
  const normalized = normalizeDecimalString_(value);
  const parts = normalized.replace(/^[-+]/, '').split('.');
  return parts[1] ? parts[1].length : 0;
}

function decimalStringToBigInt_(value, scale) {
  const normalized = normalizeDecimalString_(value);
  const negative = normalized.charAt(0) === '-';
  const unsigned = negative ? normalized.slice(1) : normalized;
  const parts = unsigned.split('.');
  const integerPart = parts[0];
  const fractionalPart = (parts[1] || '').padEnd(scale, '0');
  const digits = integerPart + fractionalPart;
  const amount = BigInt(digits || '0');
  return negative ? -amount : amount;
}

function bigIntToDecimalString_(value, scale) {
  const negative = value < 0;
  const absolute = negative ? -value : value;
  let digits = absolute.toString();
  while (digits.length <= scale) {
    digits = '0' + digits;
  }

  if (scale === 0) {
    return (negative ? '-' : '') + digits;
  }

  const integerPart = digits.slice(0, digits.length - scale) || '0';
  const fractionalPart = digits.slice(digits.length - scale).replace(/0+$/, '');
  if (!fractionalPart) {
    return (negative ? '-' : '') + integerPart;
  }
  return (negative ? '-' : '') + integerPart + '.' + fractionalPart;
}
