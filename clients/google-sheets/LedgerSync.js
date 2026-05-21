function syncLedger() {
  runUserAction_('Sync Ledger', function() {
    const perf = createPerf_();
    setActivePerf_(perf);
    try {
      ensureEditTriggerInstalled_();

      // API fetches auto-record into perf via apiFetch_
      const commodities = fetchFamilyLedgerPagedResource_(
        '/commodities?page_size=' + FAMILY_LEDGER_PAGE_SIZE,
        'commodities'
      );

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
        return buildTransactionSyncData_(transactions, accountSyncData.accountResourceToDisplayName);
      }, function(r) { return r.rows.length + ' rows'; });

      const balanceAssertions = fetchFamilyLedgerPagedResource_(
        '/balance-assertions?page_size=' + FAMILY_LEDGER_PAGE_SIZE,
        'balance_assertions'
      );
      const balanceAssertionRows = perf.wrap('data.build_balances', function() {
        return buildBalanceAssertionSyncRows_(balanceAssertions, accountSyncData.accountResourceToDisplayName);
      }, function(r) { return r.length + ' rows'; });

      const commoditiesSheet = getOrCreateSheet_(FAMILY_LEDGER_SHEET_NAMES.commodities);
      perf.wrap('sheet.write_commodities', function() {
        writeSheet_(commoditiesSheet, FAMILY_LEDGER_SHEET_REGISTRY.commodities, commodities.map(function(c) { return { symbol: c.symbol }; }));
        commoditiesSheet.setFrozenRows(1);
      }, commodities.length + ' commodities');

      const accountsSheet = getOrCreateSheet_(FAMILY_LEDGER_SHEET_NAMES.accounts);
      perf.wrap('sheet.write_accounts', function() {
        ensureSheetCapacity_(accountsSheet, FAMILY_LEDGER_SHEET_REGISTRY.accounts.headers.length, accountSyncData.accountRows.length + 1);
        writeSheet_(accountsSheet, FAMILY_LEDGER_SHEET_REGISTRY.accounts, accountSyncData.accountRows);
        accountsSheet.setFrozenRows(1);
        ensureAccountIssueFormulas_(accountsSheet, { start: 2, count: accountSyncData.accountRows.length });
      }, accountSyncData.accountRows.length + ' rows');

      const balancesSheet = getOrCreateSheet_(FAMILY_LEDGER_SHEET_NAMES.balances);
      perf.wrap('sheet.write_balances', function() {
        ensureSheetCapacity_(balancesSheet, FAMILY_LEDGER_SHEET_REGISTRY.balances.headers.length, balanceAssertionRows.length + 1);
        writeSheet_(balancesSheet, FAMILY_LEDGER_SHEET_REGISTRY.balances, balanceAssertionRows);
        balancesSheet.setFrozenRows(1);
        if (balanceAssertionRows.length > 0) {
          managedSheet_(balancesSheet, FAMILY_LEDGER_SHEET_REGISTRY.balances).setColumnFormulas(
            { start: 2, count: balanceAssertionRows.length },
            'issues',
            buildIssueLookupFormula_
          );
        }
      }, balanceAssertionRows.length + ' rows');

      const transactionsSheet = getOrCreateSheet_(FAMILY_LEDGER_SHEET_NAMES.transactions);
      perf.wrap('sheet.write_transactions', function() {
        ensureSheetCapacity_(transactionsSheet, FAMILY_LEDGER_SHEET_REGISTRY.transactions.headers.length, transactionSyncData.rows.length + 1);
        writeSheet_(transactionsSheet, FAMILY_LEDGER_SHEET_REGISTRY.transactions, transactionSyncData.rows);
        transactionsSheet.setFrozenRows(1);
        managedSheet_(transactionsSheet, FAMILY_LEDGER_SHEET_REGISTRY.transactions).setColumnFormulas(
          { start: 2, count: transactionSyncData.rows.length },
          'issues',
          buildIssueLookupFormula_
        );
      }, transactionSyncData.rows.length + ' rows');

      perf.wrap('doctor', function() { refreshDoctorIssueSheets_(accountSyncData.accountResourceToDisplayName); });

      SpreadsheetApp.getActiveSpreadsheet().toast(
        buildLedgerSyncSummaryMessage_(accountSyncData.accountCount, transactions.length, transactionSyncData, balanceAssertions.length, commodities.length),
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
      trigger.getHandlerFunction() === 'handleEntitySheetEdit_' &&
      trigger.getTriggerSourceId &&
      trigger.getTriggerSourceId() === spreadsheetId
    );
  });
  if (!existing) {
    ScriptApp.newTrigger('handleEntitySheetEdit_')
      .forSpreadsheet(spreadsheetId)
      .onEdit()
      .create();
  }
}

function buildLedgerSyncSummaryMessage_(accountCount, transactionCount, transactionSyncData, balanceAssertionCount, commodityCount) {
  const message = [
    'Synced ' + accountCount + ' accounts, ' + commodityCount + ' commodities.',
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
  const apiDataByName = {};
  accounts.forEach(function(account) { apiDataByName[account.name] = account; });
  const rows = displayEntries.map(function(entry) {
    const apiData = apiDataByName[entry.resource_name] || {};
    return {
      resource_name: entry.resource_name,
      account_name: entry.display_name,
      effective_start_date: apiData.effective_start_date || '',
      effective_end_date: apiData.effective_end_date || '',
      issues: '',
    };
  });
  const accountResourceToDisplayName = {};
  displayEntries.forEach(function(entry) {
    accountResourceToDisplayName[entry.resource_name] = entry.display_name;
  });
  return {
    accountRows: rows,
    accountResourceToDisplayName: accountResourceToDisplayName,
    accountCount: displayEntries.length,
  };
}

function buildTransactionSyncData_(transactions, accountResourceToDisplayName) {
  const rows = [];
  const skippedExamples = [];
  let skippedCount = 0;

  transactions.forEach(function(transaction) {
    const renderedRows = flattenTransactionForSheet_(transaction, accountResourceToDisplayName);
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

function buildBalanceAssertionSyncRows_(balanceAssertions, accountResourceToDisplayName) {
  return balanceAssertions.map(function(assertion) {
    return {
      resource_name: assertion.name,
      assertion_date: assertion.assertion_date,
      account: accountResourceToDisplayName[assertion.account] || assertion.account,
      amount: assertion.amount.amount,
      symbol: assertion.amount.symbol,
      issues: '',
    };
  });
}

function describeTransactionForSyncSkip_(transaction) {
  const date = transaction.transaction_date || '(missing date)';
  const payee = transaction.payee || '';
  const narration = transaction.narration || '';
  const postingCount = Array.isArray(transaction.postings) ? transaction.postings.length : 0;
  return date + ' | ' + payee + ' | ' + narration + ' | postings=' + postingCount;
}
