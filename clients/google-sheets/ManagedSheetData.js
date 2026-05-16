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

/**
 * Groups an array of row numbers into contiguous spans, sorted ascending.
 * Used when sheet operations must be applied span-by-span (e.g. data validation,
 * formula injection) and the row numbers may not be contiguous.
 *
 * @param {number[]} rowNumbers - Unsorted array of row numbers.
 * @return {{start: number, count: number}[]} Contiguous spans, ascending by start.
 */
function buildContiguousRowSpans_(rowNumbers) {
  if (rowNumbers.length === 0) {
    return [];
  }
  const sorted = rowNumbers.slice().sort(function(left, right) {
    return left - right;
  });
  const spans = [];
  let start = sorted[0];
  let end = sorted[0];

  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index] === end + 1) {
      end = sorted[index];
      continue;
    }
    spans.push({ start: start, count: end - start + 1 });
    start = sorted[index];
    end = sorted[index];
  }
  spans.push({ start: start, count: end - start + 1 });
  return spans;
}

/**
 * Returns an ascending array of `count` row numbers starting at `startRow`.
 *
 * @param {number} startRow
 * @param {number} count
 * @return {number[]}
 */
function buildSequentialRowNumbers_(startRow, count) {
  const rowNumbers = [];
  for (let index = 0; index < count; index += 1) {
    rowNumbers.push(startRow + index);
  }
  return rowNumbers;
}

/**
 * Adjusts the size of a contiguous block of sheet rows to match `newCount` by
 * inserting or deleting rows, then returns the resulting row numbers.
 * When newCount is 0 the block is deleted entirely and [] is returned.
 *
 * Assumes the existing block is contiguous and starts at firstRow.
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {number} firstRow - First row number of the existing block.
 * @param {number} existingCount - Current number of rows in the block.
 * @param {number} newCount - Desired number of rows.
 * @return {number[]} Sequential row numbers starting at firstRow, length newCount.
 */
function resizeContiguousRows_(sheet, firstRow, existingCount, newCount) {
  if (newCount > existingCount) {
    sheet.insertRowsAfter(firstRow + existingCount - 1, newCount - existingCount);
  } else if (newCount < existingCount) {
    sheet.deleteRows(firstRow + newCount, existingCount - newCount);
  }
  return buildSequentialRowNumbers_(firstRow, newCount);
}

/**
 * Converts a flat row-values array into a keyed object using the provided headers.
 *
 * @param {string[]} headers - Column header names in order.
 * @param {*[]} rowValues - Cell values in column order.
 * @return {Object}
 */
function rowToObject_(headers, rowValues) {
  const result = {};
  headers.forEach(function(header, index) {
    result[header] = rowValues[index];
  });
  return result;
}

/**
 * Returns the distinct non-blank values from the input array, preserving order
 * of first occurrence.
 *
 * @param {*[]} values
 * @return {*[]}
 */
function uniqueNonBlankValues_(values) {
  const unique = [];
  values.forEach(function(value) {
    if (!value) {
      return;
    }
    if (unique.indexOf(value) === -1) {
      unique.push(value);
    }
  });
  return unique;
}
