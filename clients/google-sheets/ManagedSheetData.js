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
  if (rowNumbers.length === 0) return [];
  if (rowNumbers.length === 1) return [readSheetRow_(sheet, sheetConfig, rowNumbers[0])];
  let contiguous = true;
  for (let i = 1; i < rowNumbers.length; i++) {
    if (rowNumbers[i] !== rowNumbers[i - 1] + 1) { contiguous = false; break; }
  }
  if (contiguous) {
    const values = sheet.getRange(rowNumbers[0], 1, rowNumbers.length, sheetConfig.headers.length).getValues();
    return values.map(function(rowValues, index) {
      const row = rowToObject_(sheetConfig.headers, rowValues);
      row.__rowNumber = rowNumbers[index];
      return row;
    });
  }
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
  if (rowNumbers.length === 0) return;
  const column = getColumnIndex_(sheetConfig, header);
  if (rowNumbers.length === 1) {
    sheet.getRange(rowNumbers[0], column).setValue(value);
    return;
  }
  let contiguous = true;
  for (let i = 1; i < rowNumbers.length; i++) {
    if (rowNumbers[i] !== rowNumbers[i - 1] + 1) { contiguous = false; break; }
  }
  if (contiguous) {
    sheet.getRange(rowNumbers[0], column, rowNumbers.length, 1).setValues(rowNumbers.map(function() { return [value]; }));
  } else {
    sheet.getRangeList(rowNumbers.map(function(r) { return sheet.getRange(r, column).getA1Notation(); })).setValue(value);
  }
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
