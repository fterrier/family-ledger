function readSheetRow_(sheet, sheetConfig, rowNumber) {
  const values = sheet.getRange(
    rowNumber,
    1,
    1,
    sheetConfig.headers.length
  ).getValues()[0];
  const row = rowToObject_(sheetConfig.headers, values);
  row.__rowNumber = rowNumber;
  return row;
}

function readSheetRowsByNumbers_(sheet, sheetConfig, rowNumbers) {
  return rowNumbers.map(function(rowNumber) {
    return readSheetRow_(sheet, sheetConfig, rowNumber);
  });
}

function writeSheetRow_(sheet, sheetConfig, rowNumber, row) {
  sheet
    .getRange(rowNumber, 1, 1, sheetConfig.headers.length)
    .setValues([materializeSheetRow_(sheetConfig, row)]);
}

function materializeSheetRow_(sheetConfig, row) {
  return sheetConfig.headers.map(function(header) {
    return row[header] ?? '';
  });
}

function setSheetFieldValuesForRowNumbers_(sheet, sheetConfig, rowNumbers, header, value) {
  const column = getColumnIndex_(sheetConfig, header);
  rowNumbers.forEach(function(rowNumber) {
    sheet.getRange(rowNumber, column).setValue(value);
  });
}

function buildIssueLookupFormula_(rowNumber) {
  return '=IFERROR(VLOOKUP($A' + rowNumber + ',Issues!$A:$D,4,FALSE),"")';
}

function ensureManagedSheetIssueFormulas_(sheet, sheetConfig, rowCount) {
  const issuesColumn = getColumnIndex_(sheetConfig, 'issues');
  if (rowCount <= 0) {
    return;
  }
  const formulas = [];
  for (let rowNumber = 2; rowNumber < rowCount + 2; rowNumber += 1) {
    formulas.push([buildIssueLookupFormula_(rowNumber)]);
  }
  sheet.getRange(2, issuesColumn, rowCount, 1).setFormulas(formulas);
}
