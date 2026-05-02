function resetSheetLayouts() {
  runUserAction_('Reset Sheet Layouts', function() {
    refreshManagedLedgerSheetLayouts_();

    SpreadsheetApp.getUi().alert(
      'Reset Sheet Layouts',
      'Layouts have been reset to their default configurations.',
      SpreadsheetApp.getUi().ButtonSet.OK
    );
  });
}

function refreshManagedLedgerSheetLayouts_() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();

  const txSheet = spreadsheet.getSheetByName(FAMILY_LEDGER_SHEET_NAMES.transactions);
  if (txSheet) {
    applyManagedSheetLayout_(txSheet, FAMILY_LEDGER_SHEET_REGISTRY.transactions);
    refreshTransactionAccountValidation_(txSheet);
    ensureTransactionSheetFilter_(txSheet);
  }

  const accSheet = spreadsheet.getSheetByName(FAMILY_LEDGER_SHEET_NAMES.accounts);
  if (accSheet) {
    applyManagedSheetLayout_(accSheet, FAMILY_LEDGER_SHEET_REGISTRY.accounts);
  }
}

function getSheetConfigByName_(sheetName) {
  const registryKeys = Object.keys(FAMILY_LEDGER_SHEET_REGISTRY);
  for (let index = 0; index < registryKeys.length; index += 1) {
    const config = FAMILY_LEDGER_SHEET_REGISTRY[registryKeys[index]];
    if (config.name === sheetName) {
      return config;
    }
  }
  throw new Error('Unknown managed sheet: ' + sheetName);
}

function requireSheetConfig_(sheetOrConfig) {
  if (sheetOrConfig && sheetOrConfig.headers && sheetOrConfig.columns) {
    return sheetOrConfig;
  }
  if (!sheetOrConfig || !sheetOrConfig.getName) {
    throw new Error('Unable to resolve sheet configuration.');
  }
  return getSheetConfigByName_(sheetOrConfig.getName());
}

function getColumnIndex_(sheetOrConfig, header) {
  const sheetConfig = requireSheetConfig_(sheetOrConfig);
  return requireHeaderColumn_(sheetConfig.columns, header, sheetConfig.key).column;
}

function getColumnLetter_(sheetOrConfig, header) {
  return columnNumberToLetter_(getColumnIndex_(sheetOrConfig, header));
}

function requireHeaderColumn_(columns, header, label) {
  const column = columns[header];
  if (!column) {
    throw new Error('Unknown ' + label + ' header: ' + header);
  }
  return column;
}

function getOrCreateSheet_(sheetName) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(sheetName);
  }
  return sheet;
}


function hideSheetIfVisible_(sheet) {
  if (!sheet.isSheetHidden || !sheet.isSheetHidden()) {
    sheet.hideSheet();
  }
}

function writeSheet_(sheet, headers, rows) {
  ensureSheetCapacity_(sheet, headers.length, rows.length + 1);
  sheet.clearContents();
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  }
}

function ensureSheetCapacity_(sheet, requiredColumns, requiredRows) {
  if (sheet.getMaxColumns && sheet.getMaxColumns() < requiredColumns) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), requiredColumns - sheet.getMaxColumns());
  }
  if (sheet.getMaxRows && sheet.getMaxRows() < requiredRows) {
    sheet.insertRowsAfter(sheet.getMaxRows(), requiredRows - sheet.getMaxRows());
  }
}

function ensureSheetCapacityForConfig_(sheet, sheetConfig) {
  ensureSheetCapacity_(sheet, sheetConfig.headers.length, Math.max(
    1,
    sheet.getLastRow ? sheet.getLastRow() : 1,
    sheet.getMaxRows ? sheet.getMaxRows() : 1
  ));
}

function applyManagedSheetLayout_(sheet, sheetConfig) {
  ensureSheetCapacityForConfig_(sheet, sheetConfig);
  applySheetHeaderLayout_(sheet, sheetConfig);
  applySheetDirectFormatting_(sheet, sheetConfig);
  ensureSheetConditionalFormatting_(sheet, sheetConfig);
  applySheetHiddenColumns_(sheet, sheetConfig);
  applySheetProtections_(sheet, sheetConfig);
}

function applySheetHeaderLayout_(sheet, sheetConfig) {
  const roleNotations = {};
  sheetConfig.headers.forEach(function(header) {
    const column = getColumnIndex_(sheetConfig, header);
    const layout = sheetConfig.columnLayout[header];
    sheet.setColumnWidth(column, layout.width);
    sheet.getRange(1, column).setNote(layout.note || '');
    if (!roleNotations[layout.role]) {
      roleNotations[layout.role] = [];
    }
    roleNotations[layout.role].push(columnNumberToLetter_(column) + '1');
  });

  Object.keys(roleNotations).forEach(function(role) {
    applyRangeListOperation_(sheet, roleNotations[role], function(rangeList) {
      rangeList
        .setBackground(FAMILY_LEDGER_HEADER_ROLE_COLORS[role])
        .setFontWeight('bold');
    });
  });
}

function applySheetDirectFormatting_(sheet, sheetConfig) {
  const totalSheetRows = sheet.getMaxRows();
  if (totalSheetRows <= 0) {
    return;
  }

  const alignmentGroups = {};
  const wrapGroups = {};
  const wrapStrategyGroups = {};
  const numberFormatGroups = {};

  sheetConfig.headers.forEach(function(header) {
    const layout = sheetConfig.columnLayout[header];
    const column = getColumnIndex_(sheetConfig, header);
    addColumnToFormatGroup_(alignmentGroups, layout.alignment, column);
    addColumnToFormatGroup_(wrapGroups, layout.wrap, column);
    addColumnToFormatGroup_(wrapStrategyGroups, layout.wrapStrategy, column);
    addColumnToFormatGroup_(numberFormatGroups, layout.numberFormat, column);
  });

  applyGroupedColumnOperation_(sheet, alignmentGroups, 1, totalSheetRows, function(target, value) {
    target.setHorizontalAlignment(value);
  });
  applyGroupedColumnOperation_(sheet, wrapGroups, 1, totalSheetRows, function(target, value) {
    target.setWrap(value === 'true');
  });
  applyGroupedColumnOperation_(sheet, wrapStrategyGroups, 1, totalSheetRows, function(target, value) {
    target.setWrapStrategy(resolveWrapStrategy_(value));
  });
  applyGroupedColumnOperation_(sheet, numberFormatGroups, 2, totalSheetRows - 1, function(target, value) {
    target.setNumberFormat(value);
  });
}

function addColumnToFormatGroup_(groups, value, column) {
  if (value === undefined || value === null || value === '') {
    return;
  }
  const key = String(value);
  if (!groups[key]) {
    groups[key] = [];
  }
  groups[key].push(column);
}

function applyGroupedColumnOperation_(sheet, groups, startRow, rowCount, apply) {
  if (rowCount <= 0) {
    return;
  }
  Object.keys(groups).forEach(function(key) {
    const notations = groups[key].map(function(column) {
      const letter = columnNumberToLetter_(column);
      return letter + startRow + ':' + letter + (startRow + rowCount - 1);
    });
    applyRangeListOperation_(sheet, notations, function(target) {
      apply(target, key);
    });
  });
}

function applyRangeListOperation_(sheet, notations, apply) {
  if (notations.length === 0) {
    return;
  }
  if (sheet.getRangeList) {
    apply(sheet.getRangeList(notations));
    return;
  }
  notations.forEach(function(notation) {
    apply(sheet.getRange(notation));
  });
}

function resolveWrapStrategy_(value) {
  if (SpreadsheetApp.WrapStrategy && SpreadsheetApp.WrapStrategy[value]) {
    return SpreadsheetApp.WrapStrategy[value];
  }
  return value;
}

function applySheetHiddenColumns_(sheet, sheetConfig) {
  ensureSheetCapacityForConfig_(sheet, sheetConfig);
  if (sheet.showColumns) {
    sheet.showColumns(1, sheetConfig.headers.length);
  }
  sheetConfig.hiddenHeaders.forEach(function(header) {
    sheet.hideColumns(getColumnIndex_(sheetConfig, header));
  });
}

function applySheetProtections_(sheet, sheetConfig) {
  ensureSheetCapacityForConfig_(sheet, sheetConfig);
  const existingProtections = sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE);
  existingProtections.forEach(function(protection) {
    protection.remove();
  });

  sheetConfig.protectedHeaders.forEach(function(header) {
    const column = getColumnIndex_(sheetConfig, header);
    const protection = sheet.getRange(1, column, Math.max(sheet.getMaxRows(), 1), 1).protect();
    protection.setDescription('Managed by Family Ledger sync');
    protection.setWarningOnly(true);
  });
}

function ensureSheetConditionalFormatting_(sheet, sheetConfig) {
  sheetConfig = requireSheetConfig_(sheetConfig || sheet);
  ensureSheetCapacityForConfig_(sheet, sheetConfig);
  const totalRows = sheet.getMaxRows();
  const fullRange = sheet.getRange(2, 1, Math.max(totalRows - 1, 1), sheetConfig.headers.length);
  const existingRules = sheet.getConditionalFormatRules();
  const preservedRules = existingRules.filter(function(rule) {
    const condition = rule.getBooleanCondition && rule.getBooleanCondition();
    if (!condition || typeof condition.getCriteriaType !== 'function') { return true; }
    if (condition.getCriteriaType() !== SpreadsheetApp.BooleanCriteria.CUSTOM_FORMULA) { return true; }
    const values = condition.getCriteriaValues();
    if (!values || values.length === 0) { return true; }
    return !isManagedConditionalFormula_(String(values[0]), sheetConfig);
  });

  appendIssueConditionalFormatting_(sheet, sheetConfig, preservedRules, fullRange);
  sheet.setConditionalFormatRules(preservedRules);
}

function appendIssueConditionalFormatting_(sheet, sheetConfig, rules, fullRange) {
  const issueColumnLetter = getColumnLetter_(sheetConfig, sheetConfig.issueHeader);
  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=$' + issueColumnLetter + '2<>""')
      .setBackground(sheetConfig.issueColor)
      .setRanges([fullRange])
      .build()
  );
}

function isManagedConditionalFormula_(formula, sheetConfig) {
  return formula === '=$' + getColumnLetter_(sheetConfig, sheetConfig.issueHeader) + '2<>""';
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
