function buildTransactionIssuesFormula_(rowNumber) {
  return '=IFERROR(VLOOKUP($A' + rowNumber + ',DoctorTransactionIssues!$A:$B,2,FALSE),"")';
}

function buildAccountIssuesFormula_(rowNumber) {
  return '=IFERROR(VLOOKUP($B' + rowNumber + ',DoctorAccountIssues!$A:$B,2,FALSE),"")';
}

function ensureTransactionIssueFormulas_(sheet, rowCount) {
  const issuesColumn = getTransactionHeaderColumnIndex_('issues');
  if (rowCount <= 0) {
    return;
  }
  const formulas = [];
  for (let rowNumber = 2; rowNumber < rowCount + 2; rowNumber += 1) {
    formulas.push([buildTransactionIssuesFormula_(rowNumber)]);
  }
  sheet.getRange(2, issuesColumn, rowCount, 1).setFormulas(formulas);
}

function ensureAccountIssueFormulas_(sheet, rowCount) {
  const issuesColumn = FAMILY_LEDGER_ACCOUNTS_HEADERS.indexOf('issues') + 1;
  if (rowCount <= 0) {
    return;
  }
  const formulas = [];
  for (let rowNumber = 2; rowNumber < rowCount + 2; rowNumber += 1) {
    formulas.push([buildAccountIssuesFormula_(rowNumber)]);
  }
  sheet.getRange(2, issuesColumn, rowCount, 1).setFormulas(formulas);
}

function ensureIssueConditionalFormatting_(sheet, headers) {
  const issueColumnLetter = columnNumberToLetter_(headers.indexOf('issues') + 1);
  const ruleFormula = '=$' + issueColumnLetter + '2<>""';
  const range = sheet.getRange(2, 1, Math.max(sheet.getMaxRows() - 1, 1), headers.length);
  const existingRules = sheet.getConditionalFormatRules();
  const preservedRules = existingRules.filter(function(rule) {
    const condition = rule.getBooleanCondition && rule.getBooleanCondition();
    if (!condition || typeof condition.getCriteriaType !== 'function') {
      return true;
    }
    if (condition.getCriteriaType() !== SpreadsheetApp.BooleanCriteria.CUSTOM_FORMULA) {
      return true;
    }
    const values = condition.getCriteriaValues();
    return !values || values.length === 0 || String(values[0]) !== ruleFormula;
  });
  preservedRules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied(ruleFormula)
      .setBackground(FAMILY_LEDGER_TRANSACTION_ISSUE_ROW_COLOR)
      .setRanges([range])
      .build()
  );
  sheet.setConditionalFormatRules(preservedRules);
}

function columnNumberToLetter_(columnNumber) {
  let value = columnNumber;
  let result = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function applyTransactionIssueHighlightingToRowNumbers_(sheet, rowNumbers, rows) {
  rowNumbers.forEach(function(rowNumber, index) {
    const range = sheet.getRange(rowNumber, 1, 1, FAMILY_LEDGER_TRANSACTION_HEADERS.length);
    if (typeof range.setBackgrounds === 'function') {
      range.setBackgrounds([buildTransactionRowBackgrounds_(rows[index] || {})]);
      return;
    }
    const backgrounds = buildTransactionRowBackgrounds_(rows[index] || {});
    backgrounds.forEach(function(color, backgroundIndex) {
      const cell = sheet.getRange(rowNumber, backgroundIndex + 1);
      if (cell && typeof cell.setBackground === 'function') {
        cell.setBackground(color);
      }
    });
  });
}

function buildTransactionRowBackgrounds_(row) {
  const hasIssues = String((row && row.issues) || '').trim() !== '';
  return FAMILY_LEDGER_TRANSACTION_HEADERS.map(function(header) {
    const layout = FAMILY_LEDGER_TRANSACTION_COLUMN_LAYOUT[header];
    const baseColor = layout ? FAMILY_LEDGER_COLUMN_ROLE_COLORS.body[layout.role] : '#ffffff';
    return hasIssues ? FAMILY_LEDGER_TRANSACTION_ISSUE_ROW_COLOR : baseColor;
  });
}

function applyTransactionSheetLayout_(sheet, rows) {
  FAMILY_LEDGER_TRANSACTION_HEADERS.forEach(function(header) {
    const column = getTransactionHeaderColumnIndex_(header);
    const layout = FAMILY_LEDGER_TRANSACTION_COLUMN_LAYOUT[header];
    if (!layout) {
      return;
    }
    sheet.setColumnWidth(column, layout.width);
    sheet.getRange(1, column).setNote(layout.note || '');
    sheet
      .getRange(1, column)
      .setBackground(FAMILY_LEDGER_COLUMN_ROLE_COLORS.header[layout.role])
      .setFontWeight('bold');
    if (rows.length > 0) {
      sheet
        .getRange(2, column, rows.length, 1)
        .setBackground(FAMILY_LEDGER_COLUMN_ROLE_COLORS.body[layout.role]);
    }
  });

  applyTransactionSheetColumnFormatting_(sheet, rows.length);
}

function applyTransactionSheetColumnFormatting_(sheet, rowCount) {
  const dateColumn = getTransactionHeaderColumnIndex_('transaction_date');
  const payeeColumn = getTransactionHeaderColumnIndex_('payee');
  const narrationColumn = getTransactionHeaderColumnIndex_('narration');
  const sourceColumn = getTransactionHeaderColumnIndex_('source_account_name');
  const destinationColumn = getTransactionHeaderColumnIndex_('destination_account_name');
  const symbolColumn = getTransactionHeaderColumnIndex_('symbol');
  const amountColumn = getTransactionHeaderColumnIndex_('amount');
  const splitColumn = getTransactionHeaderColumnIndex_('split_off_amount');
  const statusColumn = getTransactionHeaderColumnIndex_('status');
  const issuesColumn = getTransactionHeaderColumnIndex_('issues');
  const lastErrorColumn = getTransactionHeaderColumnIndex_('last_error');

  sheet.getRange(1, dateColumn, Math.max(rowCount + 1, 1), 1).setHorizontalAlignment('left');
  sheet.getRange(1, payeeColumn, Math.max(rowCount + 1, 1), 1).setHorizontalAlignment('left').setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
  sheet.getRange(1, narrationColumn, Math.max(rowCount + 1, 1), 1).setHorizontalAlignment('left');
  sheet.getRange(1, sourceColumn, Math.max(rowCount + 1, 1), 1).setHorizontalAlignment('left').setWrap(false);
  sheet.getRange(1, destinationColumn, Math.max(rowCount + 1, 1), 1).setHorizontalAlignment('left').setWrap(false);
  sheet.getRange(1, symbolColumn, Math.max(rowCount + 1, 1), 1).setHorizontalAlignment('center');
  sheet.getRange(1, amountColumn, Math.max(rowCount + 1, 1), 1).setHorizontalAlignment('right');
  sheet.getRange(1, splitColumn, Math.max(rowCount + 1, 1), 1).setHorizontalAlignment('right');
  sheet.getRange(1, statusColumn, Math.max(rowCount + 1, 1), 1).setHorizontalAlignment('center');
  sheet.getRange(1, issuesColumn, Math.max(rowCount + 1, 1), 1).setHorizontalAlignment('left').setWrap(false);
  sheet.getRange(1, lastErrorColumn, Math.max(rowCount + 1, 1), 1).setHorizontalAlignment('left').setWrap(true);
}

function applyAccountsSheetLayout_(sheet, rowCount) {
  sheet.getRange(1, 1, 1, 3).setFontWeight('bold').setBackground('#e5e7eb');
  sheet.setColumnWidth(1, 320);
  sheet.setColumnWidth(2, 180);
  sheet.setColumnWidth(3, 420);
  sheet.getRange(1, 1, Math.max(rowCount + 1, 1), 1).setWrap(false).setHorizontalAlignment('left');
  sheet.getRange(1, 2, Math.max(rowCount + 1, 1), 1).setHorizontalAlignment('left');
  sheet.getRange(1, 3, Math.max(rowCount + 1, 1), 1).setHorizontalAlignment('left').setWrap(true);
  sheet.getRange(1, 1).setNote('Visible account label used in the Transactions sheet.');
  sheet.getRange(1, 2).setNote('Technical resource name used by the client.');
  sheet.getRange(1, 3).setNote('Derived ledger doctor issues linked by account resource name.');
  ensureIssueConditionalFormatting_(sheet, FAMILY_LEDGER_ACCOUNTS_HEADERS);
  sheet.hideColumns(2);
}

function applyAccountValidation_(sheet, rowCount) {
  // TODO: Improve account UX beyond dropdown validation, especially for large account lists.
  if (rowCount === 0) {
    return;
  }

  const accountsSheet = getOrCreateSheet_(FAMILY_LEDGER_SHEET_NAMES.accounts);
  const lastRow = accountsSheet.getLastRow();
  if (lastRow <= 1) {
    return;
  }

  const rule = SpreadsheetApp.newDataValidation()
    .requireValueInRange(accountsSheet.getRange(2, 1, lastRow - 1, 1), true)
    .setAllowInvalid(false)
    .build();

  const destinationColumn = FAMILY_LEDGER_TRANSACTION_HEADERS.indexOf('destination_account_name') + 1;
  sheet.getRange(2, destinationColumn, rowCount, 1).setDataValidation(rule);
}

function applyAccountValidationToRowNumbers_(sheet, rowNumbers) {
  if (rowNumbers.length === 0) {
    return;
  }

  const accountsSheet = getOrCreateSheet_(FAMILY_LEDGER_SHEET_NAMES.accounts);
  const lastRow = accountsSheet.getLastRow();
  if (lastRow <= 1) {
    return;
  }

  const rule = SpreadsheetApp.newDataValidation()
    .requireValueInRange(accountsSheet.getRange(2, 1, lastRow - 1, 1), true)
    .setAllowInvalid(false)
    .build();

  const destinationColumn = getTransactionHeaderColumnIndex_('destination_account_name');
  rowNumbers.forEach(function(rowNumber) {
    sheet.getRange(rowNumber, destinationColumn).setDataValidation(rule);
  });
}
