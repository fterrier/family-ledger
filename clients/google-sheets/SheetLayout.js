function resetSheetLayouts() {
  runUserAction_('Reset Sheet Layouts', function() {
    const perf = createPerf_();
    setActivePerf_(perf);
    try {
      refreshManagedLedgerSheetLayouts_();
    } finally {
      clearActivePerf_();
      perf.log('Reset Layouts');
    }
    SpreadsheetApp.getUi().alert(
      'Reset Sheet Layouts',
      'Layouts have been reset to their default configurations.',
      SpreadsheetApp.getUi().ButtonSet.OK
    );
  });
}

function refreshManagedLedgerSheetLayouts_() {
  const perf = getActivePerf_();
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(FAMILY_LEDGER_SHEET_REGISTRY).forEach(function(key) {
    const sheetConfig = FAMILY_LEDGER_SHEET_REGISTRY[key];
    const sheet = spreadsheet.getSheetByName(sheetConfig.name);
    if (!sheet) return;
    if (perf) perf.start('sheet.layout_' + key);
    applyManagedSheetLayout_(sheet, sheetConfig);
    refreshAccountValidation_(sheet, sheetConfig);
    applyActionColumnCheckboxes_(sheet, sheetConfig);
    ensureSheetFilter_(sheet, sheetConfig);
    if (perf) perf.end('sheet.layout_' + key);
  });
  reapplyPersistedQuickFilters_();
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


function writeSheet_(sheet, sheetConfig, rows) {
  sheet.clearContents();
  const managed = managedSheet_(sheet, sheetConfig);
  // Clear existing account-column validations before writing. clearContents() does not remove
  // data validation rules, so a strict rule (setAllowInvalid(false)) left from a previous sync
  // or layout reset would cause setValues to throw when writing rows with blank account cells.
  const accountHeaders = sheetConfig.headers.filter(function(h) {
    return (sheetConfig.columnLayout[h] || {}).validation === 'account';
  });
  if (accountHeaders.length > 0) {
    const maxRows = sheet.getMaxRows ? sheet.getMaxRows() : 0;
    if (maxRows > 1) {
      managed.clearColumnValidations({ start: 2, count: maxRows - 1 }, accountHeaders);
      // Flush so the cleared rules are committed before setValues runs the validation check.
      if (SpreadsheetApp.flush) SpreadsheetApp.flush();
    }
  }
  managed.setHeaders();
  if (rows.length > 0) {
    managed.setRows({ start: 2, count: rows.length }, rows);
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
  if (sheetConfig.issueHeader) {
    ensureSheetConditionalFormatting_(sheet, sheetConfig);
  }
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
  const fullRange = managedSheet_(sheet, sheetConfig).getFullDataRange();
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
  // Matches any issue-state formula regardless of column, so stale rules from old
  // column positions are cleaned up when columns are added or removed.
  return /^=\$[A-Z]+2<>""$/.test(formula);
}

function applyActionColumnCheckboxes_(sheet, sheetConfig) {
  const lastRow = sheet.getMaxRows();
  if (lastRow <= 1) return;
  const ms = managedSheet_(sheet, sheetConfig);
  const validation = SpreadsheetApp.newDataValidation().requireCheckbox().build();
  sheetConfig.headers.forEach(function(header) {
    if ((sheetConfig.columnLayout[header] || {}).checkbox === true) {
      ms.setColumnValidation({ start: 2, count: lastRow - 1 }, header, validation);
    }
  });
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
