function syncLedger() {
  runUserAction_('Sync Ledger', function() {
    const perf = createPerf_();
    setActivePerf_(perf);
    try {
      ensureEditTriggerInstalled_();

      // API fetches auto-record into perf via apiFetch_
      const accounts = fetchFamilyLedgerPagedResource_(
        '/accounts?page_size=' + FAMILY_LEDGER_PAGE_SIZE,
        'accounts'
      );
      const accountSyncData = perf.wrap('data.build_accounts', function() {
        return buildAccountSyncData_(accounts);
      }, function(r) { return r.accountCount + ' accounts'; });

      const transactions = fetchFamilyLedgerPagedResource_(
        '/transactions?page_size=' + FAMILY_LEDGER_PAGE_SIZE,
        'transactions'
      );
      const transactionSyncData = perf.wrap('data.build_transactions', function() {
        return buildTransactionSyncData_(transactions, accountSyncData.accountDisplayLookup);
      }, function(r) { return r.rows.length + ' rows'; });

      const balanceAssertions = fetchFamilyLedgerPagedResource_(
        '/balance-assertions?page_size=' + FAMILY_LEDGER_PAGE_SIZE,
        'balance_assertions'
      );
      const balanceAssertionRows = perf.wrap('data.build_balances', function() {
        return buildBalanceAssertionSyncRows_(balanceAssertions, accountSyncData.accountDisplayLookup);
      }, function(r) { return r.length + ' rows'; });

      const accountsSheet = getOrCreateSheet_(FAMILY_LEDGER_SHEET_NAMES.accounts);
      perf.wrap('sheet.write_accounts', function() {
        writeSheet_(accountsSheet, FAMILY_LEDGER_SHEET_REGISTRY.accounts.headers, accountSyncData.accountRows);
        accountsSheet.setFrozenRows(1);
        ensureAccountIssueFormulas_(accountsSheet, accountSyncData.accountRows.length);
      }, accountSyncData.accountRows.length + ' rows');

      const balancesSheet = getOrCreateSheet_(FAMILY_LEDGER_SHEET_NAMES.balances);
      perf.wrap('sheet.write_balances', function() {
        writeSheet_(balancesSheet, FAMILY_LEDGER_SHEET_REGISTRY.balances.headers, balanceAssertionRows);
        balancesSheet.setFrozenRows(1);
        ensureBalancesIssueFormulas_(balancesSheet, balanceAssertionRows.length);
      }, balanceAssertionRows.length + ' rows');

      const transactionsSheet = getOrCreateSheet_(FAMILY_LEDGER_SHEET_NAMES.transactions);
      perf.wrap('sheet.write_transactions', function() {
        setTransactionSheetRows_(transactionsSheet, transactionSyncData.rows);
      }, transactionSyncData.rows.length + ' rows');

      perf.wrap('doctor', refreshDoctorIssueSheets_);

      SpreadsheetApp.getActiveSpreadsheet().toast(
        buildLedgerSyncSummaryMessage_(accountSyncData.accountCount, transactions.length, transactionSyncData, balanceAssertions.length),
        'Ledger Sync Complete',
        10
      );
    } finally {
      clearActivePerf_();
      perf.log('Sync Ledger');
    }
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

function buildLedgerSyncSummaryMessage_(accountCount, transactionCount, transactionSyncData, balanceAssertionCount) {
  const message = [
    'Synced ' + accountCount + ' accounts.',
    'Fetched ' + transactionCount + ' transactions and synced ' + transactionSyncData.rows.length + ' allocation rows.',
    'Synced ' + balanceAssertionCount + ' balance assertions.',
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
