function syncFamilyLedger() {
  runUserAction_('Sync Ledger', function() {
    ensureEditTriggerInstalled_();
    const accounts = fetchFamilyLedgerPagedResource_(
      '/accounts?page_size=' + FAMILY_LEDGER_PAGE_SIZE,
      'accounts'
    );
    const accountSyncData = buildAccountSyncData_(accounts);
    const transactions = fetchFamilyLedgerPagedResource_(
      '/transactions?page_size=' + FAMILY_LEDGER_PAGE_SIZE,
      'transactions'
    );
    const transactionSyncData = buildTransactionSyncData_(transactions, accountSyncData.accountDisplayLookup);

    const accountsSheet = getOrCreateSheet_(FAMILY_LEDGER_SHEET_NAMES.accounts);
    writeSheet_(accountsSheet, FAMILY_LEDGER_SHEET_REGISTRY.accounts.headers, accountSyncData.accountRows);
    accountsSheet.setFrozenRows(1);
    ensureAccountIssueFormulas_(accountsSheet, accountSyncData.accountRows.length);

    const transactionsSheet = getOrCreateSheet_(FAMILY_LEDGER_SHEET_NAMES.transactions);
    setTransactionSheetRows_(transactionsSheet, transactionSyncData.rows);
    writeFetchedDoctorIssueSheets_(fetchLedgerDoctorIssuesByTarget_(), getOrCreateSheet_);
    refreshManagedLedgerSheetLayouts_();

    SpreadsheetApp.getActiveSpreadsheet().toast(
      buildLedgerSyncSummaryMessage_(accountSyncData.accountCount, transactions.length, transactionSyncData),
      'Ledger Sync Complete',
      10
    );
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

function buildLedgerSyncSummaryMessage_(accountCount, transactionCount, transactionSyncData) {
  const message = [
    'Synced ' + accountCount + ' accounts.',
    'Fetched ' + transactionCount + ' transactions and synced ' + transactionSyncData.rows.length + ' allocation rows.',
  ];

  if (transactionSyncData.skippedCount > 0) {
    message.push(
      'Skipped ' + transactionSyncData.skippedCount + ' unsupported transactions. Examples:\n' +
      transactionSyncData.skippedExamples.join('\n')
    );
  }

  return message.join('\n\n');
}

function buildAccountSyncData_(accounts) {
  const displayEntries = buildAccountDisplayEntries_(accounts).sort(function(a, b) {
    return a.display_name.localeCompare(b.display_name);
  });
  const rows = displayEntries.map(function(entry) {
    return [entry.resource_name, entry.display_name, ''];
  });
  const accountDisplayLookup = {};
  displayEntries.forEach(function(entry) {
    accountDisplayLookup[entry.resource_name] = entry.display_name;
  });
  return {
    accountRows: rows,
    accountDisplayLookup: accountDisplayLookup,
    accountCount: displayEntries.length,
  };
}

function buildTransactionSyncData_(transactions, accountNameLookup) {
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
  return {
    rows: rows,
    skippedExamples: skippedExamples,
    skippedCount: skippedCount,
  };
}

function describeTransactionForSyncSkip_(transaction) {
  const date = transaction.transaction_date || '(missing date)';
  const payee = transaction.payee || '';
  const narration = transaction.narration || '';
  const postingCount = Array.isArray(transaction.postings) ? transaction.postings.length : 0;
  return date + ' | ' + payee + ' | ' + narration + ' | postings=' + postingCount;
}
