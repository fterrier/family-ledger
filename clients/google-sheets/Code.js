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
    .addSeparator()
    .addItem('Import data', 'showImportDialog')
    .addSeparator()
    .addItem('Reset Sheet Layouts', 'resetSheetLayouts')
    .addToUi();
}

function resetSheetLayouts() {
  runUserAction_('Reset Sheet Layouts', function() {
    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();

    const txSheet = spreadsheet.getSheetByName(FAMILY_LEDGER_SHEET_NAMES.transactions);
    if (txSheet) {
      const lastRow = txSheet.getLastRow();
      const rows = lastRow > 1 ? new Array(lastRow - 1) : [];
      applyTransactionSheetLayout_(txSheet, rows);
      ensureTransactionSheetFilter_(txSheet);
    }

    const accSheet = spreadsheet.getSheetByName(FAMILY_LEDGER_SHEET_NAMES.accounts);
    if (accSheet) {
      const lastRow = accSheet.getLastRow();
      applyAccountsSheetLayout_(accSheet, lastRow > 1 ? lastRow - 1 : 0);
    }

    SpreadsheetApp.getUi().alert('Reset Sheet Layouts', 'Layouts have been reset to their default configurations.', SpreadsheetApp.getUi().ButtonSet.OK);
  });
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

  debugLog_('handleTransactionEdit', {
    row: row,
    header: header,
    transactionName: transactionName,
  });

  try {
    applyTransactionEdit_(sheet, row, header, String(e.range.getValue() || ''), String(e.oldValue || ''), {
      showSuccessToast: true,
    });
  } catch (error) {
    rollbackFailedEdit_(sheet, row, header, String(e.oldValue || ''));
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
    const displayEntries = buildAccountDisplayEntries_(accounts).sort(function(a, b) {
      return a.display_name.localeCompare(b.display_name);
    });

    const sheet = getOrCreateSheet_(FAMILY_LEDGER_SHEET_NAMES.accounts);
    const rows = displayEntries.map(function(entry) {
      return [entry.display_name, entry.name, ''];
    });

    writeSheet_(sheet, FAMILY_LEDGER_ACCOUNTS_HEADERS, rows);
    sheet.setFrozenRows(1);
    ensureAccountIssueFormulas_(sheet, rows.length);
    applyAccountsSheetLayout_(sheet, rows.length);
    refreshDoctorIssueSheets_();
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

    mergeFetchedDoctorIssuesIntoRows_(rows);

    const sheet = getOrCreateSheet_(FAMILY_LEDGER_SHEET_NAMES.transactions);
    setTransactionSheetRows_(sheet, rows);
    refreshDoctorIssueSheets_();
    ensureTransactionSheetFilter_(sheet);

    SpreadsheetApp.getUi().alert(
      'Transaction Sync Complete',
      buildTransactionSyncSummaryMessage_(transactions.length, rows.length, skippedCount, skippedExamples),
      SpreadsheetApp.getUi().ButtonSet.OK
    );
  });
}

function pushActiveTransaction() {
  runUserAction_('Push Active Transaction', function() {
    const sheet = requireTransactionSheet_();
    const group = getActiveTransactionGroupFromSheet_(sheet);
    saveTransactionByName_(sheet, group.transactionName, { showSuccessAlert: true });
  });
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

function ensureTransactionSheetFilter_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return;
  const existing = sheet.getFilter();
  if (existing) existing.remove();
  sheet.getRange(1, 1, lastRow, FAMILY_LEDGER_TRANSACTION_HEADERS.length).createFilter();
}

function performSplitForRow_(sheet, rowNumber, rawSplitAmount) {
  const row = readTransactionSheetRow_(sheet, rowNumber);
  if (!row || !row.transaction_name) {
    throw new Error('The selected row does not contain a transaction.');
  }
  if (isSourceOnlyTransactionRow_(sheet, rowNumber)) {
    throw new Error('Split is unavailable until a destination account is set.');
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
  focusPostEnterAfterInsert_(sheet, rowNumber, getTransactionHeaderColumnIndex_('split_off_amount'));
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
  focusPostEnterAfterInsert_(sheet, rowNumber, getTransactionHeaderColumnIndex_('amount'));
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
    row.destination_account_name = '';
    row.split_off_amount = '';
    row.status = 'dirty';
    row.last_error = '';
    writeTransactionSheetRow_(sheet, rowNumber, row);
    focusPostEnterAfterDelete_(sheet, rowNumber, getTransactionHeaderColumnIndex_('split_off_amount'));
    return;
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
  if (isSourceOnlyTransactionRow_(sheet, rowNumber)) {
    restoreAmountCell_(sheet, rowNumber, normalizedFallbackAmount_(oldRawValue));
    throw new Error('Amount cannot be edited until a destination account is set.');
  }

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

  debugLog_('saveTransactionByName:start', {
    transactionName: transactionName,
    rowCount: rowNumbers.length,
    saveGeneration: saveGeneration,
  });

  setFieldValuesForRowNumbers_(sheet, rowNumbers, 'status', 'saving');
  setFieldValuesForRowNumbers_(sheet, rowNumbers, 'last_error', '');

  try {
    const accountNameMap = loadAccountNameMap_();
    const payload = buildTransactionPatchPayloadFromGroup_(group, accountNameMap);
    const refreshed = apiFetchJson_('patch', '/' + transactionName, {
      transaction: payload,
      update_mask: 'payee,narration,postings',
    });
    debugLog_('saveTransactionByName:patchSucceeded', {
      transactionName: transactionName,
      saveGeneration: saveGeneration,
    });
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
    debugLog_('saveTransactionByName:doctorRefreshStarting', {
      transactionName: transactionName,
      saveGeneration: saveGeneration,
    });
    ensureTransactionIssueFormulas_(sheet, sheet.getLastRow() - 1);
    refreshDoctorIssueSheets_();
    debugLog_('saveTransactionByName:doctorRefreshFinished', {
      transactionName: transactionName,
      saveGeneration: saveGeneration,
    });
  } catch (error) {
    debugLog_('saveTransactionByName:error', {
      transactionName: transactionName,
      saveGeneration: saveGeneration,
      message: error && error.message ? error.message : String(error),
    });
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
  const issues = '';

  if (shape.destinationIndexes.length === 0) {
    return [{
      transaction_name: transaction.name,
      transaction_date: parseDateString_(transaction.transaction_date),
      payee: transaction.payee || '',
      narration: transaction.narration || '',
      source_account_name: sourceAccountName,
      destination_account_name: '',
      amount: normalizeDecimalString_(negateDecimalString_(sourcePosting.units.amount)),
      split_off_amount: '',
      symbol: sourcePosting.units.symbol,
      status: '',
      issues: issues,
      last_error: '',
    }];
  }

  return shape.destinationIndexes.map(function(destinationIndex) {
    const posting = transaction.postings[destinationIndex];
    return {
      transaction_name: transaction.name,
      transaction_date: parseDateString_(transaction.transaction_date),
      payee: transaction.payee || '',
      narration: transaction.narration || '',
      source_account_name: sourceAccountName,
      destination_account_name: accountNameLookup[posting.account] || posting.account,
      amount: normalizeDecimalString_(posting.units.amount),
      split_off_amount: '',
      symbol: posting.units.symbol,
      status: '',
      issues: issues,
      last_error: '',
    };
  });
}

function classifySupportedTransaction_(transaction) {
  if (!transaction || !Array.isArray(transaction.postings) || transaction.postings.length < 1) {
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
  const blankDestinationRowNumbers = [];
  const amounts = [];

  group.rows.forEach(function(row, index) {
    const displayRow = row.__rowNumber || index + 2;
    const destinationAccountName = String(row.destination_account_name || '').trim();
    if (!destinationAccountName) {
      blankDestinationRowNumbers.push(displayRow);
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

    if (destinationAccountName) {
      destinationRows.push({
        account: resolveAccountResourceName_(accountNameMap, destinationAccountName),
        amount: amount,
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

  const totalAmount = sumDecimalStrings_(amounts);
  const postings = [{
    account: sourceAccount,
    units: {
      amount: negateDecimalString_(totalAmount),
      symbol: symbol,
    },
  }];
  destinationRows.forEach(function(row) {
    postings.push({
      account: row.account,
      units: {
        amount: row.amount,
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
  const probeRange = sheet.getRange(rowNumber, 1, 1, FAMILY_LEDGER_TRANSACTION_HEADERS.length);
  if (!probeRange || typeof probeRange.getValues !== 'function') {
    return false;
  }
  const row = readTransactionSheetRow_(sheet, rowNumber);
  const transactionName = row && row.transaction_name ? String(row.transaction_name).trim() : '';
  if (!transactionName) {
    return false;
  }
  const rowNumbers = findTransactionRowNumbers_(sheet, transactionName);
  const rows = readTransactionSheetRowsByNumbers_(sheet, rowNumbers);
  return rows.every(function(row) {
    return !String(row.destination_account_name || '').trim();
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

// ---------------------------------------------------------------------------
// Import dialog
// ---------------------------------------------------------------------------

function showImportDialog() {
  const html = HtmlService.createHtmlOutputFromFile('ImportDialog')
    .setWidth(480)
    .setHeight(560);
  SpreadsheetApp.getUi().showModalDialog(html, 'Import data');
}

function getImportersForDialog() {
  return apiFetchJson_('GET', '/importers', undefined);
}

function getAccountsForDialog() {
  return fetchFamilyLedgerPagedResource_('/accounts?page_size=500', 'accounts');
}

function runImportFromDialog(importerName, base64Content, mimeType, fileName, configOverride) {
  const bytes = Utilities.base64Decode(base64Content);
  const blob = Utilities.newBlob(bytes, mimeType || 'application/octet-stream', fileName);
  const url = buildApiUrl_(importerName + ':import');
  const resp = UrlFetchApp.fetch(url, {
    method: 'post',
    muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + getRequiredFamilyLedgerApiToken_() },
    payload: {
      file: blob,
      config_override: configOverride ? JSON.stringify(configOverride) : '',
    },
  });
  const statusCode = resp.getResponseCode();
  const body = resp.getContentText();
  if (statusCode >= 400) {
    const err = buildApiError_(statusCode, body);
    SpreadsheetApp.getActiveSpreadsheet().toast(err.message, 'Import failed', 10);
    throw err;
  }
  const result = JSON.parse(body);
  SpreadsheetApp.getActiveSpreadsheet()
    .toast(buildImportToastSummary_(result.result), 'Import complete', 15);
  return result;
}

function buildImportToastSummary_(result) {
  const entities = result.entities || {};
  const parts = Object.keys(entities).map(function(type) {
    const counts = entities[type];
    return counts.created + ' ' + type + (counts.created !== 1 ? 's' : '') + ' created';
  });
  return parts.length ? parts.join(', ') : 'No entities imported';
}
