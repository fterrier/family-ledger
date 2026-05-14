function showQuickAddTransaction() {
  const template = HtmlService.createTemplateFromFile('QuickAddTransactionSidebar');
  const html = template.evaluate().setTitle('Quick Add Transaction');
  SpreadsheetApp.getUi().showSidebar(html);
}

function includeHtml_(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function getQuickAddTransactionData() {
  const allAccounts = listAccountOptions_();
  const quickAddSourceAccounts = getQuickAddSourceAccountResources_();
  const quickAddDestinationAccounts = getQuickAddDestinationAccountResources_();
  const quickAddSymbols = getQuickAddSymbols_();
  const sourceAccountOptions = allAccounts.filter(function(option) {
    return quickAddSourceAccounts.indexOf(option.resource_name) !== -1;
  });
  const destinationAccountOptions = allAccounts.filter(function(option) {
    return quickAddDestinationAccounts.indexOf(option.resource_name) !== -1;
  });
  const commodityOptions = buildQuickAddSymbolOptions_(listCommodityOptions_(), quickAddSymbols);
  return {
    sourceAccountOptions: sourceAccountOptions,
    destinationAccountOptions: destinationAccountOptions,
    defaultSourceAccount: getQuickAddDefaultSourceAccount_(),
    defaultSymbol: getQuickAddDefaultSymbol_(),
    commodityOptions: commodityOptions,
    configured: sourceAccountOptions.length > 0 && commodityOptions.length > 0,
  };
}

function submitTransactionFromSidebar(transactionName, anchorRow, input) {
  const isEdit = Boolean(transactionName);
  return runUserAction_(isEdit ? 'Save Transaction' : 'Quick Add Transaction', function() {
    const perf = createPerf_();
    setActivePerf_(perf);
    try {
      const request = perf.wrap('data.normalize', function() {
        return normalizeQuickAddTransactionInput_(input || {}, !isEdit);
      });

      let apiResult;
      if (isEdit) {
        const payload = {
          transaction_date: request.transaction_date,
          payee: request.payee,
          narration: request.narration,
        };
        let updateMask = 'transaction_date,payee,narration';
        if (request.source_account) {
          payload.postings = buildTransactionPostings_(request);
          updateMask += ',postings';
        } else if (input && input.rawPostings && input.rawPostings.length > 0) {
          payload.postings = input.rawPostings;
          updateMask += ',postings';
        }
        apiResult = apiFetchJson_('patch', '/' + transactionName, {
          transaction: payload,
          update_mask: updateMask,
        });
      } else {
        apiResult = apiFetchJson_('post', '/transactions', {
          transaction: buildQuickAddTransactionPayload_(request),
        });
      }

      const sheet = perf.wrap('sheet.get', function() {
        return getOrCreateSheet_(FAMILY_LEDGER_SHEET_NAMES.transactions);
      });
      const accountLookup = perf.wrap('data.load_accounts', function() {
        return loadAccountDisplayLookup_();
      });
      const renderedRows = flattenTransactionForSheet_(apiResult, accountLookup);

      if (isEdit && renderedRows === null) {
        throw new Error('The updated transaction is no longer editable in this Sheets client.');
      }
      if (!isEdit && (!renderedRows || renderedRows.length === 0)) {
        throw new Error('Created transaction could not be rendered into the Transactions sheet.');
      }
      if (isEdit) {
        renderedRows.forEach(function(row) { row.status = 'saved'; });
      }

      const rowNumbers = perf.wrap('sheet.find_rows', function() {
        if (isEdit) {
          return findTransactionRowNumbersFromAnchor_(sheet, anchorRow).rowNumbers;
        }
        const insertionRow = findInsertionRowForTransactionDate_(sheet, request.transaction_date);
        const lastRow = sheet.getLastRow();
        let startRow;
        if (lastRow <= 1) {
          startRow = 2;
        } else if (insertionRow <= lastRow) {
          sheet.insertRowsBefore(insertionRow, renderedRows.length);
          startRow = insertionRow;
        } else {
          sheet.insertRowsAfter(Math.max(lastRow, 1), renderedRows.length);
          startRow = Math.max(lastRow + 1, 2);
        }
        return buildSequentialRowNumbers_(startRow, renderedRows.length);
      });

      perf.wrap('sheet.write_rows', function() {
        sheet.getRange(rowNumbers[0], 1, rowNumbers.length, FAMILY_LEDGER_SHEET_REGISTRY.transactions.headers.length)
          .setValues(renderedRows.map(materializeTransactionSheetRow_));
        applyAccountValidationToRowNumbers_(sheet, rowNumbers);
        applyTransactionIssueFormulasToRowNumbers_(sheet, rowNumbers);
      });

      perf.wrap('doctor', function() { refreshDoctorIssueSheets_(accountLookup); });

      if (isEdit) {
        SpreadsheetApp.getActiveSpreadsheet().toast('Transaction saved.', 'Edit Transaction', 5);
        return {};
      } else {
        const payeeColumn = getTransactionHeaderColumnIndex_('payee');
        SpreadsheetApp.getActiveSpreadsheet().setActiveSheet(sheet);
        focusCell_(sheet, rowNumbers[0], payeeColumn);
        SpreadsheetApp.getActiveSpreadsheet().toast(
          'Inserted transaction on ' + request.transaction_date + '.',
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

function normalizeQuickAddTransactionInput_(input, requireShortlistSource) {
  if (requireShortlistSource === undefined) requireShortlistSource = true;
  const transactionDate = normalizeTransactionDate_(input.transaction_date || '');
  const payee = String(input.payee || '').trim();
  const narration = String(input.narration || '').trim();
  if (!transactionDate) throw new Error('Transaction date is required.');

  const needsPostingFields = (input.postingCount == null || input.postingCount === 2);
  let sourceAccount = null, destinationAccount = null, symbol = null, amount = null;
  if (needsPostingFields) {
    sourceAccount = String(input.source_account || '').trim();
    destinationAccount = String(input.destination_account || '').trim();
    symbol = String(input.symbol || '').trim();
    amount = parseFloat(String(input.amount || '').trim());
    if (!sourceAccount) throw new Error('Source account is required.');
    if (!symbol) throw new Error('Symbol is required.');
    if (isNaN(amount)) throw new Error('Amount must be a valid number.');
    if (amount === 0) throw new Error('Amount must be non-zero.');
    if (requireShortlistSource) {
      const allowed = getQuickAddSourceAccountResources_();
      if (allowed.indexOf(sourceAccount) === -1)
        throw new Error('Source account is not part of the quick add shortlist.');
    }
  }
  return {
    transaction_date: transactionDate,
    source_account: sourceAccount,
    destination_account: destinationAccount || null,
    symbol: symbol,
    amount: amount,
    payee: payee || null,
    narration: narration || null,
  };
}

function buildTransactionPostings_(request) {
  const postings = [{
    account: request.source_account,
    units: { amount: String(-request.amount), symbol: request.symbol },
  }];
  if (request.destination_account) {
    postings.push({
      account: request.destination_account,
      units: { amount: String(request.amount), symbol: request.symbol },
    });
  }
  return postings;
}

function buildQuickAddTransactionPayload_(request) {
  return {
    transaction_date: request.transaction_date,
    payee: request.payee,
    narration: request.narration,
    entity_metadata: { source: 'google_sheets_quick_add' },
    postings: buildTransactionPostings_(request),
  };
}

function buildTransactionGroupAnchors_(sheet) {
  const lastRow = sheet.getLastRow();
  const anchors = [];
  if (lastRow <= 1) return anchors;
  const nameCol = getTransactionHeaderColumnIndex_('resource_name');
  const dateCol = getTransactionHeaderColumnIndex_('transaction_date');
  const startCol = Math.min(nameCol, dateCol);
  const colCount = Math.max(nameCol, dateCol) - startCol + 1;
  const values = sheet.getRange(2, startCol, lastRow - 1, colCount).getValues();
  let current = null;
  values.forEach(function(rowValues, index) {
    const transactionName = String(rowValues[nameCol - startCol] || '').trim();
    if (!transactionName) return;
    const rowNumber = index + 2;
    const transactionDate = normalizeTransactionDate_(rowValues[dateCol - startCol]);
    if (!current || current.transactionName !== transactionName) {
      if (current) anchors.push(current);
      current = { transactionName: transactionName, firstRow: rowNumber, lastRow: rowNumber, transactionDate: transactionDate };
      return;
    }
    current.lastRow = rowNumber;
  });
  if (current) anchors.push(current);
  return anchors;
}

function findInsertionRowForTransactionDate_(sheet, transactionDate) {
  const normalizedDate = normalizeTransactionDate_(transactionDate);
  const anchors = buildTransactionGroupAnchors_(sheet);
  for (let index = 0; index < anchors.length; index += 1) {
    if (anchors[index].transactionDate > normalizedDate) {
      return anchors[index].firstRow;
    }
  }
  const lastAnchor = anchors[anchors.length - 1];
  return lastAnchor ? lastAnchor.lastRow + 1 : 2;
}

function applyTransactionIssueFormulasToRowNumbers_(sheet, rowNumbers) {
  if (!rowNumbers || rowNumbers.length === 0) {
    return;
  }
  const issuesColumn = getTransactionHeaderColumnIndex_('issues');
  rowNumbers.forEach(function(rowNumber) {
    sheet.getRange(rowNumber, issuesColumn).setFormula(buildIssueLookupFormula_(rowNumber));
  });
}


function getEditTransactionData(transactionName) {
  const transaction = apiFetchJson_('get', '/' + transactionName);
  const allAccounts = listAccountOptions_();
  const commodities = listCommodityOptions_();
  const postingCount = Array.isArray(transaction.postings) ? transaction.postings.length : 0;
  const result = {
    transaction: transaction,
    accounts: allAccounts,
    commodities: commodities,
    postingCount: postingCount,
  };
  if (postingCount === 2) {
    const sourceIdx = transaction.postings.findIndex(function(p) {
      return parseFloat(p.units.amount) < 0;
    });
    const destIdx = sourceIdx === -1 ? 1 : 1 - sourceIdx;
    const src = transaction.postings[sourceIdx === -1 ? 0 : sourceIdx];
    const dst = transaction.postings[destIdx];
    result.sourceAccount = src.account;
    result.destinationAccount = dst.account;
    result.amount = Math.abs(parseFloat(src.units.amount));
    result.symbol = src.units.symbol;
  }
  return result;
}

function deleteTransactionFromSidebar(transactionName, anchorRow) {
  return runUserAction_('Delete Transaction', function() {
    apiFetchJson_('delete', '/' + transactionName);
    const sheet = getOrCreateSheet_(FAMILY_LEDGER_SHEET_NAMES.transactions);
    const { rowNumbers } = findTransactionRowNumbersFromAnchor_(sheet, anchorRow);
    replaceTransactionRowsInSheet_(sheet, rowNumbers, []);
    refreshDoctorIssueSheets_();
    SpreadsheetApp.getActiveSpreadsheet().toast('Transaction deleted.', 'Edit Transaction', 5);
  });
}

function getSidebarData(transactionName) {
  if (transactionName) {
    const transaction = apiFetchJson_('get', '/' + transactionName);
    const allAccounts = listAccountOptions_();
    const commodities = listCommodityOptions_();
    const postingCount = Array.isArray(transaction.postings) ? transaction.postings.length : 0;
    const result = {
      configured: true,
      postingCount: postingCount,
      rawPostings: transaction.postings || [],
      sourceAccountOptions: allAccounts,
      destinationAccountOptions: allAccounts,
      commodityOptions: commodities,
      defaultDate: transaction.transaction_date || '',
      defaultPayee: transaction.payee || '',
      defaultNarration: transaction.narration || '',
      defaultSourceAccount: null,
      defaultDestinationAccount: null,
      defaultAmount: null,
      defaultSymbol: null,
    };
    if (postingCount === 2) {
      const sourceIdx = transaction.postings.findIndex(function(p) {
        return parseFloat(p.units.amount) < 0;
      });
      const src = transaction.postings[sourceIdx === -1 ? 0 : sourceIdx];
      const dst = transaction.postings[sourceIdx === -1 ? 1 : 1 - sourceIdx];
      result.defaultSourceAccount = src.account;
      result.defaultDestinationAccount = dst.account;
      result.defaultAmount = Math.abs(parseFloat(src.units.amount));
      result.defaultSymbol = src.units.symbol;
    }
    return result;
  }
  const allAccounts = listAccountOptions_();
  const quickAddSourceAccounts = getQuickAddSourceAccountResources_();
  const quickAddDestinationAccounts = getQuickAddDestinationAccountResources_();
  const quickAddSymbols = getQuickAddSymbols_();
  const sourceAccountOptions = allAccounts.filter(function(o) {
    return quickAddSourceAccounts.indexOf(o.resource_name) !== -1;
  });
  const destinationAccountOptions = allAccounts.filter(function(o) {
    return quickAddDestinationAccounts.indexOf(o.resource_name) !== -1;
  });
  const commodityOptions = buildQuickAddSymbolOptions_(listCommodityOptions_(), quickAddSymbols);
  return {
    configured: sourceAccountOptions.length > 0 && commodityOptions.length > 0,
    postingCount: null,
    sourceAccountOptions: sourceAccountOptions,
    destinationAccountOptions: destinationAccountOptions,
    commodityOptions: commodityOptions,
    defaultDate: null,
    defaultPayee: null,
    defaultNarration: null,
    defaultSourceAccount: getQuickAddDefaultSourceAccount_(),
    defaultDestinationAccount: null,
    defaultAmount: null,
    defaultSymbol: getQuickAddDefaultSymbol_(),
  };
}
