function showQuickAddTransaction() {
  const template = HtmlService.createTemplateFromFile('QuickAddTransactionSidebar');
  const html = template.evaluate().setTitle('Quick Add Transaction');
  SpreadsheetApp.getUi().showSidebar(html);
}

function includeHtml_(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function submitTransactionFromSidebar(transactionName, anchorRow, input) {
  const isEdit = Boolean(transactionName);
  return runUserAction_(isEdit ? 'Save Transaction' : 'Quick Add Transaction', function() {
    const perf = createPerf_();
    setActivePerf_(perf);
    try {
      const { transaction_date = '', payee: rawPayee = '', narration: rawNarration = '', postings } = input || {};
      const transactionDate = normalizeTransactionDate_(transaction_date);
      if (!transactionDate) throw new Error('Transaction date is required.');
      const payee = String(rawPayee).trim() || null;
      const narration = String(rawNarration).trim() || null;

      let apiResult;
      if (isEdit) {
        apiResult = apiFetchJson_('patch', '/' + transactionName, {
          transaction: { transaction_date: transactionDate, payee: payee, narration: narration, postings: postings },
          update_mask: 'transaction_date,payee,narration,postings',
        });
      } else {
        apiResult = apiFetchJson_('post', '/transactions', {
          transaction: {
            transaction_date: transactionDate,
            payee: payee,
            narration: narration,
            postings: postings,
            entity_metadata: { source: 'google_sheets_quick_add' },
          },
        });
      }

      const sheet = perf.wrap('sheet.get', function() {
        return getOrCreateSheet_(FAMILY_LEDGER_SHEET_NAMES.transactions);
      });
      const accountOptions = perf.wrap('data.load_accounts', function() {
        return loadAccountOptions_();
      });
      const accountResourceToDisplayName = {};
      accountOptions.forEach(function(o) { accountResourceToDisplayName[o.resource_name] = o.display_name; });
      const renderedRows = flattenTransactionForSheet_(apiResult, accountResourceToDisplayName);

      if (!renderedRows || renderedRows.length === 0) {
        throw new Error('Transaction could not be rendered into the Transactions sheet.');
      }
      if (isEdit) {
        renderedRows.forEach(function(row) { row.status = 'saved'; });
      }

      const rowNumbers = perf.wrap('sheet.apply_rows', function() {
        const existingRowNumbers = isEdit
          ? findTransactionRowNumbersFromAnchor_(sheet, anchorRow).rowNumbers
          : null;
        return applyTransactionResponseToSheet_(sheet, existingRowNumbers, null, renderedRows);
      });

      perf.wrap('doctor', function() { refreshDoctorIssueSheets_(accountResourceToDisplayName); });

      if (isEdit) {
        SpreadsheetApp.getActiveSpreadsheet().toast('Transaction saved.', 'Edit Transaction', 5);
        return {};
      } else {
        const payeeColumn = getTransactionHeaderColumnIndex_('payee');
        SpreadsheetApp.getActiveSpreadsheet().setActiveSheet(sheet);
        focusCell_(sheet, rowNumbers[0], payeeColumn);
        SpreadsheetApp.getActiveSpreadsheet().toast(
          'Inserted transaction on ' + transactionDate + '.',
          'Quick Add Transaction', 5
        );
        return { transactionName: apiResult.name, rowNumbers: rowNumbers };
      }
    } finally {
      clearActivePerf_();
      perf.log(isEdit ? 'Save Transaction' : 'Quick Add Transaction');
    }
  });
}

function deleteTransactionFromSidebar(transactionName, anchorRow) {
  return runUserAction_('Delete Transaction', function() {
    apiFetchJson_('delete', '/' + transactionName);
    const sheet = getOrCreateSheet_(FAMILY_LEDGER_SHEET_NAMES.transactions);
    const { rowNumbers } = findTransactionRowNumbersFromAnchor_(sheet, anchorRow);
    replaceTransactionRowsInSheet_(sheet, rowNumbers, []);
    const accountOptions = loadAccountOptions_();
    const accountResourceToDisplayName = {};
    accountOptions.forEach(function(o) { accountResourceToDisplayName[o.resource_name] = o.display_name; });
    refreshDoctorIssueSheets_(accountResourceToDisplayName);
    SpreadsheetApp.getActiveSpreadsheet().toast('Transaction deleted.', 'Edit Transaction', 5);
  });
}

function getSidebarData(transactionName) {
  if (transactionName) {
    const transaction = apiFetchJson_('get', '/' + transactionName);
    const allAccounts = loadAccountOptions_();
    const allCommodities = listCommodityOptions_();
    const postingCount = Array.isArray(transaction.postings) ? transaction.postings.length : 0;
    const result = {
      configured: true,
      postingCount: postingCount,
      rawPostings: transaction.postings || [],
      allAccountOptions: allAccounts,
      allCommodityOptions: allCommodities,
      sourceAccountOptions: allAccounts,
      destinationAccountOptions: allAccounts,
      commodityOptions: allCommodities,
      defaultDate: transaction.transaction_date || '',
      defaultPayee: transaction.payee || '',
      defaultNarration: transaction.narration || '',
      defaultSourceAccount: null,
      defaultDestinationAccount: null,
      defaultAmount: null,
      defaultSymbol: null,
    };
    if (postingCount === 1 || postingCount === 2) {
      const sourceIdx = transaction.postings.findIndex(function(p) {
        return parseFloat(p.units.amount) < 0;
      });
      const src = transaction.postings[sourceIdx === -1 ? 0 : sourceIdx];
      result.defaultSourceAccount = src.account;
      result.defaultAmount = Math.abs(parseFloat(src.units.amount));
      result.defaultSymbol = src.units.symbol;
      if (postingCount === 2) {
        const dst = transaction.postings[sourceIdx === -1 ? 1 : 1 - sourceIdx];
        result.defaultDestinationAccount = dst.account;
      }
    }
    return result;
  }
  const settings = getAllQuickAddSettings_();
  const allAccounts = loadAccountOptions_();
  const allCommodities = listCommodityOptions_();
  const sourceAccountOptions = allAccounts.filter(function(o) {
    return settings.sourceAccounts.indexOf(o.resource_name) !== -1;
  });
  const destinationAccountOptions = allAccounts.filter(function(o) {
    return settings.destinationAccounts.indexOf(o.resource_name) !== -1;
  });
  const commodityOptions = buildQuickAddSymbolOptions_(allCommodities, settings.symbols);
  return {
    configured: sourceAccountOptions.length > 0 && commodityOptions.length > 0,
    postingCount: null,
    allAccountOptions: allAccounts,
    allCommodityOptions: allCommodities,
    sourceAccountOptions: sourceAccountOptions,
    destinationAccountOptions: destinationAccountOptions,
    commodityOptions: commodityOptions,
    defaultDate: null,
    defaultPayee: null,
    defaultNarration: null,
    defaultSourceAccount: settings.defaultSourceAccount || null,
    defaultDestinationAccount: null,
    defaultAmount: null,
    defaultSymbol: settings.defaultSymbol || null,
  };
}
