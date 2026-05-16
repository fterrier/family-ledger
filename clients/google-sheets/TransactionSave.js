// Orchestrates the full save lifecycle for a transaction:
//   - sets status='saving' on existing span before the API call
//   - on error: writes status='error' + last_error, always rethrows
//   - on success: flushes so 'saved' is briefly visible, refreshes doctor, then clears status to ''
//
// existingSpan: null for POST (new), {start, count} for PATCH (edit)
// transactionName: null for POST (skips generation tracking); string for PATCH
// accountLookup: resource_name → display_name map passed to flattenTransactionForSheet_
// doApiCall(saveGeneration): makes the API call; return null to abort (stale generation)
// Returns finalSpan, or null if aborted.
function saveTransactionToSheet_(sheet, existingSpan, transactionName, accountLookup, doApiCall) {
  const txConfig = FAMILY_LEDGER_SHEET_REGISTRY.transactions;
  if (existingSpan) {
    managedSheet_(sheet, txConfig).setFields(existingSpan, { status: 'saving', last_error: '' });
    SpreadsheetApp.flush();
  }

  const saveGeneration = transactionName ? beginSaveGeneration_(transactionName) : null;
  let finalSpan;

  try {
    const apiResult = doApiCall(saveGeneration);
    if (!apiResult) return null;

    const replacementRows = flattenTransactionForSheet_(apiResult, accountLookup);
    if (!replacementRows || replacementRows.length === 0) {
      throw new Error('Transaction could not be rendered into the Transactions sheet.');
    }
    replacementRows.forEach(function(row) {
      row.split_off_amount = '';
      row.status = 'saved';
      row.last_error = '';
    });

    const perf = getActivePerf_();
    finalSpan = perf
      ? perf.wrap('sheet.apply_rows', function() {
          return applyTransactionResponseToSheet_(sheet, existingSpan, replacementRows);
        })
      : applyTransactionResponseToSheet_(sheet, existingSpan, replacementRows);
  } catch (error) {
    if (existingSpan && (!saveGeneration || isCurrentSaveGeneration_(transactionName, saveGeneration))) {
      const errorMsg = error.message || String(error);
      managedSheet_(sheet, txConfig).setFields(existingSpan, { status: 'error', last_error: errorMsg });
    }
    throw error;
  }

  if (!finalSpan) return null;

  SpreadsheetApp.flush();
  const perf = getActivePerf_();
  try {
    if (perf) {
      perf.wrap('doctor', function() { refreshDoctorIssueSheets_(accountLookup); });
    } else {
      refreshDoctorIssueSheets_(accountLookup);
    }
  } catch (error) {
    SpreadsheetApp.getActiveSpreadsheet().toast(
      'Saved changes, but failed to refresh ledger doctor issues: ' + (error.message || String(error)),
      'Family Ledger',
      5
    );
  }
  managedSheet_(sheet, txConfig).setFields(finalSpan, { status: '' });
  return finalSpan;
}

function saveTransactionByName_(sheet, precomputed, options, accountOptions) {
  options = options || {};
  const perf = createPerf_();
  setActivePerf_(perf);
  try {
    const { span, transactionName, rows } = precomputed;
    const accountResourceToDisplayName = {};
    const accountDisplayNameToResource = {};
    (accountOptions || []).forEach(function(o) {
      accountResourceToDisplayName[o.resource_name] = o.display_name;
      accountDisplayNameToResource[o.display_name] = o.resource_name;
    });

    try {
      saveTransactionToSheet_(sheet, span, transactionName, accountResourceToDisplayName,
        function(saveGeneration) {
          const payload = perf.wrap('data.build_payload', function() {
            return buildTransactionPatchPayload_(rows, accountDisplayNameToResource);
          });
          const refreshed = perf.wrap('api.patch', function() {
            return apiFetchJson_('patch', '/' + transactionName, {
              transaction: payload,
              update_mask: 'payee,narration,postings',
            });
          });
          if (!isCurrentSaveGeneration_(transactionName, saveGeneration)) return null;
          return refreshed;
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
    } else {
      SpreadsheetApp.getActiveSpreadsheet().toast('Transaction saved.', 'Family Ledger', 3);
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
