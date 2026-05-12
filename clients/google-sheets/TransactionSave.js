function pushActiveTransaction() {
  runUserAction_('Push Active Transaction', function() {
    const sheet = requireTransactionSheet_();
    const group = getActiveTransactionGroupFromSheet_(sheet);
    saveTransactionByName_(sheet, group.transactionName, { showSuccessAlert: true });
  });
}

function saveTransactionByName_(sheet, transactionName, options) {
  options = options || {};
  const perf = createPerf_();
  setActivePerf_(perf);
  try {
    const rowNumbers = perf.wrap('sheet.read_rows', function() {
      return findTransactionRowNumbers_(sheet, transactionName);
    }, function(r) { return r.length + ' rows'; });
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
      const { nameMap: accountNameMap, displayLookup: accountNameLookup } = loadAccountMaps_();
      const payload = perf.wrap('data.build_payload', function() {
        return buildTransactionPatchPayloadFromGroup_(group, accountNameMap);
      });
      // PATCH auto-records via apiFetch_
      const refreshed = apiFetchJson_('patch', '/' + transactionName, {
        transaction: payload,
        update_mask: 'payee,narration,postings',
      });
      debugLog_('saveTransactionByName:patchSucceeded', {
        transactionName: transactionName,
        saveGeneration: saveGeneration,
      });
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
      perf.wrap('sheet.update_rows', function() {
        if (areTransactionRowsEquivalentForRefresh_(rows, replacementRows)) {
          setFieldValuesForRowNumbers_(sheet, rowNumbers, 'status', 'saved');
          setFieldValuesForRowNumbers_(sheet, rowNumbers, 'last_error', '');
        } else if (canUpdateTransactionRowsInPlace_(rows, replacementRows)) {
          updateTransactionRowsInPlace_(sheet, rowNumbers, rows, replacementRows);
        } else {
          replaceTransactionRowsInSheet_(sheet, rowNumbers, replacementRows);
          ensureTransactionIssueFormulas_(sheet, sheet.getLastRow() - 1);
        }
      }, replacementRows.length + ' rows');

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
      return;
    }

    debugLog_('saveTransactionByName:doctorRefreshStarting', { transactionName: transactionName, saveGeneration: saveGeneration });
    try {
      perf.wrap('doctor', refreshDoctorIssueSheets_);
    } catch (error) {
      debugLog_('refreshVisibleLedgerIssuesFromDoctor:error', {
        message: error && error.message ? error.message : String(error),
      });
      SpreadsheetApp.getActiveSpreadsheet().toast(
        'Saved changes, but failed to refresh ledger doctor issues: ' + (error.message || String(error)),
        'Family Ledger',
        5
      );
    }
    debugLog_('saveTransactionByName:doctorRefreshFinished', { transactionName: transactionName, saveGeneration: saveGeneration });
  } finally {
    clearActivePerf_();
    perf.log('Save Transaction');
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
