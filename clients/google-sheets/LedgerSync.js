function runWithPerf_(label, fn) {
  const perf = createPerf_();
  setActivePerf_(perf);
  try {
    return fn(perf);
  } finally {
    clearActivePerf_();
    perf.log(label);
  }
}

function syncLedger() {
  runUserAction_('Sync Ledger', function() {
    runWithPerf_('Sync Ledger', function(perf) {
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

      const prices = fetchFamilyLedgerPagedResource_(
        '/prices?page_size=' + FAMILY_LEDGER_PAGE_SIZE,
        'prices'
      );
      const priceRows = perf.wrap('data.build_prices', function() {
        return buildPriceSyncRows_(prices);
      }, function(r) { return r.length + ' rows'; });

      const attachments = fetchFamilyLedgerPagedResource_(
        '/attachments?page_size=' + FAMILY_LEDGER_PAGE_SIZE,
        'attachments'
      );
      const attachmentRows = perf.wrap('data.build_attachments', function() {
        return buildAttachmentSyncRows_(attachments, accountSyncData.accountResourceToDisplayName);
      }, function(r) { return r.length + ' rows'; });

      const commoditiesSheet = getOrCreateSheet_(FAMILY_LEDGER_SHEET_NAMES.commodities);
      perf.wrap('sheet.write_commodities', function() {
        writeSheet_(commoditiesSheet, FAMILY_LEDGER_SHEET_REGISTRY.commodities, commodities.map(function(c) { return { edit: false, resource_name: c.name, symbol: c.symbol }; }));
        commoditiesSheet.setFrozenRows(1);
      }, commodities.length + ' commodities');

      const accountsSheet = getOrCreateSheet_(FAMILY_LEDGER_SHEET_NAMES.accounts);
      perf.wrap('sheet.write_accounts', function() {
        ensureSheetCapacity_(accountsSheet, FAMILY_LEDGER_SHEET_REGISTRY.accounts.headers.length, accountSyncData.accountRows.length + 1);
        writeSheet_(accountsSheet, FAMILY_LEDGER_SHEET_REGISTRY.accounts, accountSyncData.accountRows);
        accountsSheet.setFrozenRows(1);
        managedSheet_(accountsSheet, FAMILY_LEDGER_SHEET_REGISTRY.accounts).setColumnFormulas(
          { start: 2, count: accountSyncData.accountRows.length },
          'issues',
          buildIssueLookupFormula_
        );
      }, accountSyncData.accountRows.length + ' rows');

      const pricesSheet = getOrCreateSheet_(FAMILY_LEDGER_SHEET_NAMES.prices);
      perf.wrap('sheet.write_prices', function() {
        ensureSheetCapacity_(pricesSheet, FAMILY_LEDGER_SHEET_REGISTRY.prices.headers.length, priceRows.length + 1);
        writeSheet_(pricesSheet, FAMILY_LEDGER_SHEET_REGISTRY.prices, priceRows);
        pricesSheet.setFrozenRows(1);
      }, priceRows.length + ' rows');

      const balancesSheet = getOrCreateSheet_(FAMILY_LEDGER_SHEET_NAMES.balances);
      perf.wrap('sheet.write_balances', function() {
        ensureSheetCapacity_(balancesSheet, FAMILY_LEDGER_SHEET_REGISTRY.balances.headers.length, balanceAssertionRows.length + 1);
        writeSheet_(balancesSheet, FAMILY_LEDGER_SHEET_REGISTRY.balances, balanceAssertionRows);
        balancesSheet.setFrozenRows(1);
        managedSheet_(balancesSheet, FAMILY_LEDGER_SHEET_REGISTRY.balances).setColumnFormulas(
          { start: 2, count: balanceAssertionRows.length },
          'issues',
          buildIssueLookupFormula_
        );
      }, balanceAssertionRows.length + ' rows');

      const attachmentsSheet = getOrCreateSheet_(FAMILY_LEDGER_SHEET_NAMES.attachments);
      perf.wrap('sheet.write_attachments', function() {
        ensureSheetCapacity_(attachmentsSheet, FAMILY_LEDGER_SHEET_REGISTRY.attachments.headers.length, attachmentRows.length + 1);
        writeSheet_(attachmentsSheet, FAMILY_LEDGER_SHEET_REGISTRY.attachments, attachmentRows);
        attachmentsSheet.setFrozenRows(1);
        managedSheet_(attachmentsSheet, FAMILY_LEDGER_SHEET_REGISTRY.attachments).setColumnFormulas(
          { start: 2, count: attachmentRows.length },
          'issues',
          buildIssueLookupFormula_
        );
      }, attachmentRows.length + ' rows');

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

      perf.wrap('sheet.restore_filters', function() { restoreAllSheetFilters_(); });
      perf.wrap('sheet.restore_validations', function() { restoreAllAccountValidations_(); });

      SpreadsheetApp.getActiveSpreadsheet().toast(
        buildLedgerSyncSummaryMessage_(accountSyncData.accountCount, transactions.length, transactionSyncData, balanceAssertions.length, commodities.length, attachments.length, prices.length),
        'Ledger Sync Complete',
        10
      );
      invalidateAccountOptionsCache_();
    });
  });
}


var INCREMENTAL_SYNC_MAX_ = 200;

var IMPORT_RESOURCE_TO_SHEET_KEY_ = {
  transactions: 'transactions',
  attachments: 'attachments',
  balance_assertions: 'balances',
  accounts: 'accounts',
  prices: 'prices',
  commodities: 'commodities',
};

function syncLedgerAfterImport(importResult) {
  const createdResources = (importResult && importResult.created_resources) || {};
  const totalCreated = Object.keys(createdResources).reduce(function(sum, k) {
    return sum + (createdResources[k] || []).length;
  }, 0);
  if (totalCreated === 0) return;
  if (totalCreated > INCREMENTAL_SYNC_MAX_) { syncLedger(); return; }

  runWithPerf_('Sync After Import', function(perf) {
    let insertedCount = 0;
    Object.keys(createdResources).forEach(function(resourceType) {
      const sheetKey = IMPORT_RESOURCE_TO_SHEET_KEY_[resourceType];
      if (!sheetKey) return;
      const EntityClass = ENTITY_CLASS_REGISTRY[sheetKey];
      if (!EntityClass) return;
      const names = createdResources[resourceType];
      if (!names || names.length === 0) return;
      const sheet = getOrCreateSheet_(FAMILY_LEDGER_SHEET_REGISTRY[sheetKey].name);
      perf.wrap('sheet.insert_' + resourceType, function() {
        names.forEach(function(name) {
          EntityClass.loadFromApi(name).insertIntoSheet(sheet);
          insertedCount += 1;
        });
      }, names.length + ' entities');
    });

    if (insertedCount === 0) return;
    refreshDoctorIssueSheets_({});
    invalidateAccountOptionsCache_();
    SpreadsheetApp.getActiveSpreadsheet().toast(
      insertedCount + ' entities added to sheet.',
      'Import Sync Complete', 10
    );
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

function buildLedgerSyncSummaryMessage_(accountCount, transactionCount, transactionSyncData, balanceAssertionCount, commodityCount, attachmentCount, priceCount) {
  const message = [
    'Synced ' + accountCount + ' accounts, ' + commodityCount + ' commodities, ' + (priceCount || 0) + ' prices.',
    'Fetched ' + transactionCount + ' transactions and synced ' + transactionSyncData.rows.length + ' allocation rows.',
    'Synced ' + balanceAssertionCount + ' balance assertions.',
    'Synced ' + (attachmentCount || 0) + ' attachments.',
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
    return Account.fromApi_(apiDataByName[entry.resource_name]).toRows_()[0];
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

function buildPriceSyncRows_(prices) {
  return prices.map(function(price) { return Price.fromApi_(price).toRows_()[0]; });
}

function buildBalanceAssertionSyncRows_(balanceAssertions, accountResourceToDisplayName) {
  const context = { accountResourceToDisplayName: accountResourceToDisplayName };
  return balanceAssertions.map(function(assertion) {
    return Balance.fromApi_(assertion, context).toRows_()[0];
  });
}

function buildAttachmentSyncRows_(attachments, accountResourceToDisplayName) {
  const context = { accountResourceToDisplayName: accountResourceToDisplayName };
  return attachments.map(function(attachment) {
    return Attachment.fromApi_(attachment, context).toRows_()[0];
  });
}

function describeTransactionForSyncSkip_(transaction) {
  const date = transaction.transaction_date || '(missing date)';
  const payee = transaction.payee || '';
  const narration = transaction.narration || '';
  const postingCount = Array.isArray(transaction.postings) ? transaction.postings.length : 0;
  return date + ' | ' + payee + ' | ' + narration + ' | postings=' + postingCount;
}
