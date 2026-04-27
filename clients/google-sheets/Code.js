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
      transaction_date: transaction.transaction_date,
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
      transaction_date: transaction.transaction_date,
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

function formatTransactionIssuesForSheet_(issues) {
  if (!Array.isArray(issues) || issues.length === 0) {
    return '';
  }
  return issues.map(formatTransactionIssueForSheet_).join('\n');
}

function fetchLedgerDoctorIssuesByTarget_() {
  const response = apiFetchJson_('post', '/ledger:doctor', {});
  const byTarget = {};
  const issues = Array.isArray(response.issues) ? response.issues : [];
  issues.forEach(function(issue) {
    if (!issue || !issue.target) {
      return;
    }
    if (!byTarget[issue.target]) {
      byTarget[issue.target] = [];
    }
    byTarget[issue.target].push(issue);
  });
  debugLog_('fetchLedgerDoctorIssuesByTarget', {
    issueCount: issues.length,
    targetCount: Object.keys(byTarget).length,
    sampleTargets: Object.keys(byTarget).slice(0, 5),
  });
  return byTarget;
}

function partitionDoctorIssuesByTargetType_(issuesByTarget) {
  const transactionIssues = {};
  const accountIssues = {};
  Object.keys(issuesByTarget).forEach(function(target) {
    if (target.indexOf('transactions/') === 0) {
      transactionIssues[target] = issuesByTarget[target];
      return;
    }
    if (target.indexOf('accounts/') === 0) {
      accountIssues[target] = issuesByTarget[target];
    }
  });
  return {
    transactionIssues: transactionIssues,
    accountIssues: accountIssues,
  };
}

function doctorIssuesToSheetRows_(issuesByTarget) {
  return Object.keys(issuesByTarget)
    .sort()
    .map(function(target) {
      return [target, formatTransactionIssuesForSheet_(issuesByTarget[target] || [])];
    });
}

function mergeDoctorIssuesIntoRows_(rows, issuesByTarget) {
  rows.forEach(function(row) {
    row.issues = formatTransactionIssuesForSheet_(issuesByTarget[row.transaction_name] || []);
  });
}

function mergeFetchedDoctorIssuesIntoRows_(rows) {
  const issuesByTarget = fetchLedgerDoctorIssuesByTarget_();
  mergeDoctorIssuesIntoRows_(rows, issuesByTarget);
  return issuesByTarget;
}

function refreshTransactionIssuesFromDoctor_(sheet, transactionName) {
  try {
    refreshDoctorIssueSheets_(transactionName);
  } catch (error) {
    debugLog_('refreshTransactionIssuesFromDoctor:error', {
      transactionName: transactionName || '',
      message: error && error.message ? error.message : String(error),
    });
    SpreadsheetApp.getActiveSpreadsheet().toast(
      'Saved transaction, but failed to refresh ledger doctor issues: ' + (error.message || String(error)),
      'Family Ledger',
      5
    );
  }
}

function refreshDoctorIssueSheets_(transactionName) {
  const issuesByTarget = fetchLedgerDoctorIssuesByTarget_();
  const partitioned = partitionDoctorIssuesByTargetType_(issuesByTarget);
    debugLog_('refreshTransactionIssuesFromDoctorSync:fetched', {
    transactionName: transactionName || '',
    issueCount: Object.values(issuesByTarget).reduce(function(total, issues) {
      return total + issues.length;
    }, 0),
    targetFound: transactionName ? Object.prototype.hasOwnProperty.call(issuesByTarget, transactionName) : false,
  });
  writeDoctorIssueSheet_(
    getOrCreateSheet_(FAMILY_LEDGER_SHEET_NAMES.doctorTransactionIssues),
    doctorIssuesToSheetRows_(partitioned.transactionIssues)
  );
  writeDoctorIssueSheet_(
    getOrCreateSheet_(FAMILY_LEDGER_SHEET_NAMES.doctorAccountIssues),
    doctorIssuesToSheetRows_(partitioned.accountIssues)
  );
  debugLog_('refreshDoctorIssueSheets:written', {
    transactionIssueTargets: Object.keys(partitioned.transactionIssues).length,
    accountIssueTargets: Object.keys(partitioned.accountIssues).length,
    transactionName: transactionName || '',
  });
}

function applyFetchedDoctorIssuesToExistingSheet_(sheet, issuesByTarget, transactionName) {
  const existing = readVisibleTransactionRows_(sheet);
  mergeDoctorIssuesIntoRows_(existing.rows, issuesByTarget);
  const targetRow = transactionName
    ? existing.rows.find(function(row) {
      return row.transaction_name === transactionName;
    })
    : null;
  debugLog_('applyFetchedDoctorIssuesToExistingSheet', {
    transactionName: transactionName || '',
    visibleRowCount: existing.rowNumbers.length,
    rowFound: !!targetRow,
    mergedIssues: targetRow ? String(targetRow.issues || '') : '',
  });
  applyDoctorIssuesToSheetRowNumbers_(sheet, existing.rowNumbers, existing.rows);
}

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

function applyDoctorIssuesToExistingSheet_(sheet, issuesByTarget) {
  applyFetchedDoctorIssuesToExistingSheet_(sheet, issuesByTarget);
}

function getFamilyLedgerDebugLogsEnabled_() {
  const value = PropertiesService.getScriptProperties().getProperty('FAMILY_LEDGER_DEBUG_LOGS');
  return String(value || '').trim().toLowerCase() === 'true';
}

function debugLog_(eventName, fields) {
  if (!getFamilyLedgerDebugLogsEnabled_()) {
    return;
  }
  let serializedFields = '{}';
  try {
    serializedFields = JSON.stringify(fields || {});
  } catch {
    serializedFields = '{"serialization_error":true}';
  }
  console.log('[family-ledger] ' + eventName + ' ' + serializedFields);
}

function applyDoctorIssuesToSheetRowNumbers_(sheet, rowNumbers, rows) {
  if (!rowNumbers || rowNumbers.length === 0) {
    return;
  }
  const issuesColumn = getTransactionHeaderColumnIndex_('issues');
  rowNumbers.forEach(function(rowNumber, index) {
    sheet.getRange(rowNumber, issuesColumn).setValue(rows[index].issues || '');
  });
  applyTransactionIssueHighlightingToRowNumbers_(sheet, rowNumbers, rows);
}

function writeDoctorIssueSheet_(sheet, rows) {
  writeSheet_(sheet, FAMILY_LEDGER_DOCTOR_ISSUES_HEADERS, rows);
  hideSheetIfVisible_(sheet);
}

function buildTransactionIssuesFormula_(rowNumber) {
  return '=IFERROR(VLOOKUP($A' + rowNumber + ',DoctorTransactionIssues!$A:$B,2,FALSE),"")';
}

function buildAccountIssuesFormula_(rowNumber) {
  return '=IFERROR(VLOOKUP($B' + rowNumber + ',DoctorAccountIssues!$A:$B,2,FALSE),"")';
}

function ensureTransactionIssueFormulas_(sheet, rowCount) {
  const issuesColumn = getTransactionHeaderColumnIndex_('issues');
  if (rowCount <= 0) {
    return;
  }
  const formulas = [];
  for (let rowNumber = 2; rowNumber < rowCount + 2; rowNumber += 1) {
    formulas.push([buildTransactionIssuesFormula_(rowNumber)]);
  }
  sheet.getRange(2, issuesColumn, rowCount, 1).setFormulas(formulas);
}

function ensureAccountIssueFormulas_(sheet, rowCount) {
  const issuesColumn = FAMILY_LEDGER_ACCOUNTS_HEADERS.indexOf('issues') + 1;
  if (rowCount <= 0) {
    return;
  }
  const formulas = [];
  for (let rowNumber = 2; rowNumber < rowCount + 2; rowNumber += 1) {
    formulas.push([buildAccountIssuesFormula_(rowNumber)]);
  }
  sheet.getRange(2, issuesColumn, rowCount, 1).setFormulas(formulas);
}

function ensureIssueConditionalFormatting_(sheet, headers) {
  const issueColumnLetter = columnNumberToLetter_(headers.indexOf('issues') + 1);
  const ruleFormula = '=$' + issueColumnLetter + '2<>""';
  const range = sheet.getRange(2, 1, Math.max(sheet.getMaxRows() - 1, 1), headers.length);
  const existingRules = sheet.getConditionalFormatRules();
  const preservedRules = existingRules.filter(function(rule) {
    const condition = rule.getBooleanCondition && rule.getBooleanCondition();
    if (!condition || typeof condition.getCriteriaType !== 'function') {
      return true;
    }
    if (condition.getCriteriaType() !== SpreadsheetApp.BooleanCriteria.CUSTOM_FORMULA) {
      return true;
    }
    const values = condition.getCriteriaValues();
    return !values || values.length === 0 || String(values[0]) !== ruleFormula;
  });
  preservedRules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied(ruleFormula)
      .setBackground(FAMILY_LEDGER_TRANSACTION_ISSUE_ROW_COLOR)
      .setRanges([range])
      .build()
  );
  sheet.setConditionalFormatRules(preservedRules);
}

function columnNumberToLetter_(columnNumber) {
  let value = columnNumber;
  let result = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function formatTransactionIssueForSheet_(issue) {
  if (!issue || !issue.code) {
    return '';
  }
  const details = issue.details || {};
  if (issue.code === 'transaction_unbalanced') {
    const parts = [];
    if (details.symbol) {
      parts.push(String(details.symbol));
    }
    if (details.residual_amount) {
      parts.push('residual ' + String(details.residual_amount));
    }
    if (details.tolerance_amount) {
      parts.push('tolerance ' + String(details.tolerance_amount));
    }
    return 'transaction_unbalanced' + (parts.length > 0 ? ' (' + parts.join(', ') + ')' : '');
  }
  return issue.code + (issue.message ? ': ' + issue.message : '');
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
  applyTransactionIssueHighlightingToRowNumbers_(sheet, [rowNumber], [row]);
}

function materializeTransactionSheetRow_(row) {
  return FAMILY_LEDGER_TRANSACTION_HEADERS.map(function(header) {
    return row[header] || '';
  });
}

function applyTransactionIssueHighlighting_(sheet, rows) {
  if (!rows || rows.length === 0) {
    return;
  }
  sheet
    .getRange(2, 1, rows.length, FAMILY_LEDGER_TRANSACTION_HEADERS.length)
    .setBackgrounds(rows.map(buildTransactionRowBackgrounds_));
}

function applyTransactionIssueHighlightingToRowNumbers_(sheet, rowNumbers, rows) {
  rowNumbers.forEach(function(rowNumber, index) {
    const range = sheet.getRange(rowNumber, 1, 1, FAMILY_LEDGER_TRANSACTION_HEADERS.length);
    if (typeof range.setBackgrounds === 'function') {
      range.setBackgrounds([buildTransactionRowBackgrounds_(rows[index] || {})]);
      return;
    }
    const backgrounds = buildTransactionRowBackgrounds_(rows[index] || {});
    backgrounds.forEach(function(color, backgroundIndex) {
      const cell = sheet.getRange(rowNumber, backgroundIndex + 1);
      if (cell && typeof cell.setBackground === 'function') {
        cell.setBackground(color);
      }
    });
  });
}

function buildTransactionRowBackgrounds_(row) {
  const hasIssues = String((row && row.issues) || '').trim() !== '';
  return FAMILY_LEDGER_TRANSACTION_HEADERS.map(function(header) {
    const layout = FAMILY_LEDGER_TRANSACTION_COLUMN_LAYOUT[header];
    const baseColor = layout ? FAMILY_LEDGER_COLUMN_ROLE_COLORS.body[layout.role] : '#ffffff';
    return hasIssues ? FAMILY_LEDGER_TRANSACTION_ISSUE_ROW_COLOR : baseColor;
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

function applyTransactionSheetLayout_(sheet, rows) {
  FAMILY_LEDGER_TRANSACTION_HEADERS.forEach(function(header) {
    const column = getTransactionHeaderColumnIndex_(header);
    const layout = FAMILY_LEDGER_TRANSACTION_COLUMN_LAYOUT[header];
    if (!layout) {
      return;
    }
    sheet.setColumnWidth(column, layout.width);
    sheet.getRange(1, column).setNote(layout.note || '');
    sheet
      .getRange(1, column)
      .setBackground(FAMILY_LEDGER_COLUMN_ROLE_COLORS.header[layout.role])
      .setFontWeight('bold');
    if (rows.length > 0) {
      sheet
        .getRange(2, column, rows.length, 1)
        .setBackground(FAMILY_LEDGER_COLUMN_ROLE_COLORS.body[layout.role]);
    }
  });

  applyTransactionSheetColumnFormatting_(sheet, rows.length);
}

function applyTransactionSheetColumnFormatting_(sheet, rowCount) {
  const dateColumn = getTransactionHeaderColumnIndex_('transaction_date');
  const payeeColumn = getTransactionHeaderColumnIndex_('payee');
  const narrationColumn = getTransactionHeaderColumnIndex_('narration');
  const sourceColumn = getTransactionHeaderColumnIndex_('source_account_name');
  const destinationColumn = getTransactionHeaderColumnIndex_('destination_account_name');
  const symbolColumn = getTransactionHeaderColumnIndex_('symbol');
  const amountColumn = getTransactionHeaderColumnIndex_('amount');
  const splitColumn = getTransactionHeaderColumnIndex_('split_off_amount');
  const statusColumn = getTransactionHeaderColumnIndex_('status');
  const issuesColumn = getTransactionHeaderColumnIndex_('issues');
  const lastErrorColumn = getTransactionHeaderColumnIndex_('last_error');

  sheet.getRange(1, dateColumn, Math.max(rowCount + 1, 1), 1).setHorizontalAlignment('left');
  sheet.getRange(1, payeeColumn, Math.max(rowCount + 1, 1), 1).setHorizontalAlignment('left').setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
  sheet.getRange(1, narrationColumn, Math.max(rowCount + 1, 1), 1).setHorizontalAlignment('left');
  sheet.getRange(1, sourceColumn, Math.max(rowCount + 1, 1), 1).setHorizontalAlignment('left').setWrap(false);
  sheet.getRange(1, destinationColumn, Math.max(rowCount + 1, 1), 1).setHorizontalAlignment('left').setWrap(false);
  sheet.getRange(1, symbolColumn, Math.max(rowCount + 1, 1), 1).setHorizontalAlignment('center');
  sheet.getRange(1, amountColumn, Math.max(rowCount + 1, 1), 1).setHorizontalAlignment('right');
  sheet.getRange(1, splitColumn, Math.max(rowCount + 1, 1), 1).setHorizontalAlignment('right');
  sheet.getRange(1, statusColumn, Math.max(rowCount + 1, 1), 1).setHorizontalAlignment('center');
  sheet.getRange(1, issuesColumn, Math.max(rowCount + 1, 1), 1).setHorizontalAlignment('left').setWrap(false);
  sheet.getRange(1, lastErrorColumn, Math.max(rowCount + 1, 1), 1).setHorizontalAlignment('left').setWrap(true);
}

function applyAccountsSheetLayout_(sheet, rowCount) {
  sheet.getRange(1, 1, 1, 3).setFontWeight('bold').setBackground('#e5e7eb');
  sheet.setColumnWidth(1, 320);
  sheet.setColumnWidth(2, 180);
  sheet.setColumnWidth(3, 420);
  sheet.getRange(1, 1, Math.max(rowCount + 1, 1), 1).setWrap(false).setHorizontalAlignment('left');
  sheet.getRange(1, 2, Math.max(rowCount + 1, 1), 1).setHorizontalAlignment('left');
  sheet.getRange(1, 3, Math.max(rowCount + 1, 1), 1).setHorizontalAlignment('left').setWrap(true);
  sheet.getRange(1, 1).setNote('Visible account label used in the Transactions sheet.');
  sheet.getRange(1, 2).setNote('Technical resource name used by the client.');
  sheet.getRange(1, 3).setNote('Derived ledger doctor issues linked by account resource name.');
  ensureIssueConditionalFormatting_(sheet, FAMILY_LEDGER_ACCOUNTS_HEADERS);
  sheet.hideColumns(2);
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

function buildAccountDisplayEntries_(accounts) {
  return accounts.map(function(account) {
    return {
      name: account.name,
      account_name: account.account_name,
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
  const displayEntries = buildAccountDisplayEntries_(accounts);
  const lookup = {};
  displayEntries.forEach(function(account) {
    lookup[account.name] = account.display_name;
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
