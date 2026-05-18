// Backward-compat save helper for saveTransactionToSheet_. Phase 3 will remove this.
// Accepts a doApiCall callback because QuickAddTransaction.js passes custom API logic
// (entity_metadata on POST, specific update_mask). Cannot use entity.save() directly.
function saveEntity_(entity, sheet, existingSpan, context, doApiCall) {
  const entityName = entity.getName();
  const saveGeneration = entityName ? beginSaveGeneration_(entityName) : null;
  let finalSpan;

  try {
    const apiResult = doApiCall(saveGeneration);
    if (!apiResult) return null;

    entity.updateFromApi_(apiResult);

    const rows = entity.toRows_();
    if (!rows || rows.length === 0) {
      throw new Error('Entity could not be rendered into the sheet.');
    }

    const resetFields = entity.constructor.RESET_ON_SAVE_FIELDS || [];
    rows.forEach(function(row) {
      resetFields.forEach(function(f) { row[f] = ''; });
    });

    finalSpan = entity.constructor.writeToSheet_(sheet, existingSpan, rows);
  } catch (error) {
    throw error;
  }

  if (!finalSpan) return null;

  try {
    refreshDoctorIssueSheets_(context.accountResourceToDisplayName || {});
  } catch (error) {
    SpreadsheetApp.getActiveSpreadsheet().toast(
      'Saved changes, but failed to refresh ledger doctor issues: ' + (error.message || String(error)),
      'Family Ledger',
      5
    );
  }
  return finalSpan;
}

// Shim for QuickAddTransaction.js — Phase 3 will replace this with entity.save().
// Creates a minimal Transaction entity (name only) for save generation tracking;
// the entity is updated from the API result before rows are written.
function saveTransactionToSheet_(sheet, existingSpan, transactionName, accountLookup, doApiCall) {
  const context = {
    accountResourceToDisplayName: accountLookup || {},
    accountDisplayNameToResource: {},
  };
  const entity = Transaction.fromApi({ name: transactionName || null }, context);
  return saveEntity_(entity, sheet, existingSpan, context, doApiCall);
}
