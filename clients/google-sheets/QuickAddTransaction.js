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

function quickAddTransactionFromSidebar(input) {
  return runUserAction_('Quick Add Transaction', function() {
    const perf = createPerf_();
    setActivePerf_(perf);
    try {
      const request = perf.wrap('data.normalize', function() {
        return normalizeQuickAddTransactionInput_(input || {});
      });
      // api.POST /transactions auto-recorded via apiFetch_
      const created = apiFetchJson_('post', '/transactions', {
        transaction: buildQuickAddTransactionPayload_(request),
      });
      const sheet = perf.wrap('sheet.get', function() {
        const s = getOrCreateSheet_(FAMILY_LEDGER_SHEET_NAMES.transactions);
        return s;
      });
      const accountLookup = perf.wrap('data.load_accounts', function() {
        return loadAccountDisplayLookup_();
      });
      const renderedRows = flattenTransactionForSheet_(created, accountLookup);
      if (!renderedRows || renderedRows.length === 0) {
        throw new Error('Created transaction could not be rendered into the Transactions sheet.');
      }
      const insertionRow = perf.wrap('sheet.find_insertion_row', function() {
        return findInsertionRowForTransactionDate_(sheet, request.transaction_date);
      });
      const insertedRowNumbers = perf.wrap('sheet.insert_rows', function() {
        return insertTransactionRowsAtRow_(sheet, insertionRow, renderedRows);
      }, renderedRows.length + ' rows');
      const payeeColumn = getTransactionHeaderColumnIndex_('payee');
      SpreadsheetApp.getActiveSpreadsheet().setActiveSheet(sheet);
      focusCell_(sheet, insertedRowNumbers[0], payeeColumn);
      SpreadsheetApp.getActiveSpreadsheet().toast(
        'Inserted transaction on ' + request.transaction_date + '.',
        'Quick Add Transaction',
        5
      );
      perf.wrap('doctor', function() { refreshDoctorIssueSheets_(accountLookup); });
      return {
        transactionName: created.name,
        rowNumbers: insertedRowNumbers,
      };
    } finally {
      clearActivePerf_();
      perf.log('Quick Add Transaction');
    }
  });
}

function normalizeQuickAddTransactionInput_(input) {
  const transactionDate = normalizeTransactionDate_(input.transaction_date || '');
  const sourceAccount = String(input.source_account || '').trim();
  const destinationAccount = String(input.destination_account || '').trim();
  const symbol = String(input.symbol || '').trim();
  const amount = parseFloat(String(input.amount || '').trim());
  const payee = String(input.payee || '').trim();
  const narration = String(input.narration || '').trim();

  if (!transactionDate) {
    throw new Error('Transaction date is required.');
  }
  if (!sourceAccount) {
    throw new Error('Source account is required.');
  }
  if (!symbol) {
    throw new Error('Symbol is required.');
  }
  if (isNaN(amount)) {
    throw new Error('Amount must be a valid number.');
  }
  if (amount === 0) {
    throw new Error('Amount must be non-zero.');
  }

  const allowedSourceAccounts = getQuickAddSourceAccountResources_();
  if (allowedSourceAccounts.indexOf(sourceAccount) === -1) {
    throw new Error('Source account is not part of the quick add shortlist.');
  }

  return {
    transaction_date: transactionDate,
    source_account: sourceAccount,
    destination_account: destinationAccount,
    symbol: symbol,
    amount: amount,
    payee: payee || null,
    narration: narration || null,
  };
}

function buildQuickAddTransactionPayload_(request) {
  const sourceAmount = -request.amount;
  const postings = [{
    account: request.source_account,
    units: {
      amount: String(sourceAmount),
      symbol: request.symbol,
    },
  }];
  if (request.destination_account) {
    postings.push({
      account: request.destination_account,
      units: {
        amount: String(request.amount),
        symbol: request.symbol,
      },
    });
  }
  return {
    transaction_date: request.transaction_date,
    payee: request.payee,
    narration: request.narration,
    entity_metadata: {
      source: 'google_sheets_quick_add',
    },
    postings: postings,
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

function insertTransactionRowsAtRow_(sheet, insertionRow, rows) {
  if (rows.length === 0) {
    return [];
  }
  const rowCount = rows.length;
  let startRow = insertionRow;
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) {
    startRow = 2;
    sheet.getRange(startRow, 1, rowCount, FAMILY_LEDGER_SHEET_REGISTRY.transactions.headers.length)
      .setValues(rows.map(materializeTransactionSheetRow_));
  } else if (startRow <= lastRow) {
    sheet.insertRowsBefore(startRow, rowCount);
    sheet.getRange(startRow, 1, rowCount, FAMILY_LEDGER_SHEET_REGISTRY.transactions.headers.length)
      .setValues(rows.map(materializeTransactionSheetRow_));
  } else {
    sheet.insertRowsAfter(Math.max(lastRow, 1), rowCount);
    startRow = Math.max(lastRow + 1, 2);
    sheet.getRange(startRow, 1, rowCount, FAMILY_LEDGER_SHEET_REGISTRY.transactions.headers.length)
      .setValues(rows.map(materializeTransactionSheetRow_));
  }
  const rowNumbers = buildSequentialRowNumbers_(startRow, rowCount);
  applyAccountValidationToRowNumbers_(sheet, rowNumbers);
  applyTransactionIssueFormulasToRowNumbers_(sheet, rowNumbers);
  return rowNumbers;
}
