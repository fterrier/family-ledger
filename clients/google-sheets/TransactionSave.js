function pushActiveTransaction() {
  runUserAction_('Push Active Transaction', function() {
    const sheet = requireTransactionSheet_();
    const group = getActiveTransactionGroupFromSheet_(sheet);
    const accountOptions = loadAccountOptions_();
    saveTransactionByName_(sheet, group, { showSuccessAlert: true }, accountOptions);
  });
}

// Orchestrates the full save lifecycle for any sheet entity row(s):
//   - sets status='saving' on existing rows before the API call
//   - on error: writes status='error' + last_error, always rethrows
//   - on success: flushes so 'saved' is briefly visible, runs afterSave, then clears status
//
// existingRowNumbers: null for new entities (POST), array for existing (PATCH)
// entityName: string key for save-generation tracking (PATCH); null skips tracking (POST)
// doSave(saveGeneration): makes the API call and applies the response to the sheet;
//   return null to abort (stale generation), return finalRowNumbers on success
// afterSave(finalRowNumbers): runs post-save work (doctor refresh etc.); errors are the caller's responsibility
// Returns finalRowNumbers, or null if aborted.
function saveEntityToSheet_(sheet, existingRowNumbers, entityName, doSave, afterSave) {
  if (existingRowNumbers) {
    setFieldValuesForRowNumbers_(sheet, existingRowNumbers, 'status', 'saving');
    setFieldValuesForRowNumbers_(sheet, existingRowNumbers, 'last_error', '');
    SpreadsheetApp.flush();
  }

  const saveGeneration = entityName ? beginSaveGeneration_(entityName) : null;
  let finalRowNumbers;

  try {
    finalRowNumbers = doSave(saveGeneration);
  } catch (error) {
    if (existingRowNumbers && (!saveGeneration || isCurrentSaveGeneration_(entityName, saveGeneration))) {
      setFieldValuesForRowNumbers_(sheet, existingRowNumbers, 'status', 'error');
      setFieldValuesForRowNumbers_(sheet, existingRowNumbers, 'last_error', error.message || String(error));
    }
    throw error;
  }

  if (!finalRowNumbers) return null;

  SpreadsheetApp.flush();
  afterSave(finalRowNumbers);
  setFieldValuesForRowNumbers_(sheet, finalRowNumbers, 'status', '');
  return finalRowNumbers;
}

function saveTransactionByName_(sheet, precomputed, options, accountOptions) {
  options = options || {};
  const perf = createPerf_();
  setActivePerf_(perf);
  try {
    const { rowNumbers, transactionName, rows } = precomputed;
    const group = {
      transactionName: transactionName,
      activeIndex: 0,
      rowNumbers: rowNumbers,
      rows: rows,
      contiguous: isContiguousRowNumbers_(rowNumbers),
    };
    const accountResourceToDisplayName = {};
    const accountDisplayNameToResource = {};
    (accountOptions || []).forEach(function(o) {
      accountResourceToDisplayName[o.resource_name] = o.display_name;
      accountDisplayNameToResource[o.display_name] = o.resource_name;
    });

    try {
      saveEntityToSheet_(sheet, rowNumbers, transactionName,
        function(saveGeneration) {
          const payload = perf.wrap('data.build_payload', function() {
            return buildTransactionPatchPayloadFromGroup_(group, accountDisplayNameToResource);
          });
          const refreshed = apiFetchJson_('patch', '/' + transactionName, {
            transaction: payload,
            update_mask: 'payee,narration,postings',
          });
          if (!isCurrentSaveGeneration_(transactionName, saveGeneration)) return null;
          const replacementRows = flattenTransactionForSheet_(refreshed, accountResourceToDisplayName);
          if (replacementRows === null) {
            throw new Error('The updated transaction is no longer editable in this Sheets client.');
          }
          replacementRows.forEach(function(row) {
            row.split_off_amount = '';
            row.status = 'saved';
            row.last_error = '';
          });
          return perf.wrap('sheet.update_rows', function() {
            return applyTransactionResponseToSheet_(sheet, rowNumbers, rows, replacementRows);
          }, replacementRows.length + ' rows');
        },
        function() {
          try {
            perf.wrap('doctor', function() { refreshDoctorIssueSheets_(accountResourceToDisplayName); });
          } catch (error) {
            SpreadsheetApp.getActiveSpreadsheet().toast(
              'Saved changes, but failed to refresh ledger doctor issues: ' + (error.message || String(error)),
              'Family Ledger',
              5
            );
          }
        }
      );
    } catch (error) {
      if (options.showSuccessAlert) throw error;
      return;
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
  } finally {
    clearActivePerf_();
    perf.log('Save Transaction');
  }
}

function beginSaveGeneration_(transactionName) {
  const properties = PropertiesService.getDocumentProperties();
  const key = 'family_ledger_save_generation:' + transactionName;
  const currentValue = parseInt(properties.getProperty(key) || '0', 10);
  const nextValue = String(currentValue + 1);
  properties.setProperty(key, nextValue);
  return nextValue;
}

function isCurrentSaveGeneration_(transactionName, generation) {
  return PropertiesService.getDocumentProperties().getProperty('family_ledger_save_generation:' + transactionName) === generation;
}
