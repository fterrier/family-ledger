function managedSheet_(sheet, sheetConfig) {
  return {
    setHeaders: function() {
      sheet.getRange(1, 1, 1, sheetConfig.headers.length)
        .setValues([sheetConfig.headers.map(function(h) { return sheetConfig.columnLayout[h].header_text; })]);
    },

    setRow: function(rowNumber, row) {
      this.setRows({ start: rowNumber, count: 1 }, [row]);
    },

    setRows: function(span, rows) {
      if (span.count === 0) return;
      // issueHeader is formula-managed — never written by setRows.
      // Assumption: issueHeader is always the last column when present.
      const issueIdx = sheetConfig.issueHeader != null
        ? sheetConfig.headers.indexOf(sheetConfig.issueHeader)
        : -1;
      const numCols = issueIdx !== -1 ? issueIdx : sheetConfig.headers.length;
      if (numCols === 0) return;
      sheet.getRange(span.start, 1, span.count, numCols)
        .setValues(rows.map(function(row) {
          return sheetConfig.headers.slice(0, numCols).map(function(h) {
            return (h in row) ? row[h] : '';
          });
        }));
    },

    // Write {header: value} map, same values to ALL rows in span.
    // Batches contiguous columns into one getRange call each.
    setFields: function(span, fields) {
      if (span.count === 0) return;
      const pairs = [];
      sheetConfig.headers.forEach(function(h) {
        if (h in fields) {
          pairs.push({ col: getColumnIndex_(sheetConfig, h), value: fields[h] });
        }
      });
      if (pairs.length === 0) return;
      let i = 0;
      while (i < pairs.length) {
        const groupStart = pairs[i].col;
        const groupValues = [pairs[i].value];
        let j = i + 1;
        while (j < pairs.length && pairs[j].col === groupStart + groupValues.length) {
          groupValues.push(pairs[j].value);
          j++;
        }
        const rows = [];
        for (let r = 0; r < span.count; r++) rows.push(groupValues.slice());
        sheet.getRange(span.start, groupStart, span.count, groupValues.length).setValues(rows);
        i = j;
      }
    },

    // fn(rowNumber) → formula string; writes to one column across span.
    setColumnFormulas: function(span, header, fn) {
      if (span.count === 0) return;
      const col = getColumnIndex_(sheetConfig, header);
      const formulas = [];
      for (let r = 0; r < span.count; r++) formulas.push([fn(span.start + r, sheetConfig)]);
      sheet.getRange(span.start, col, span.count, 1).setFormulas(formulas);
    },

    // Read rows as [{header: value}] objects.
    // headerSubset limits which columns are fetched; reads the minimal column rect.
    getRows: function(span, headerSubset) {
      if (span.count === 0) return [];
      const headers = headerSubset || sheetConfig.headers;
      let minCol = Infinity;
      let maxCol = -Infinity;
      headers.forEach(function(h) {
        const col = getColumnIndex_(sheetConfig, h);
        if (col < minCol) minCol = col;
        if (col > maxCol) maxCol = col;
      });
      const values = sheet.getRange(span.start, minCol, span.count, maxCol - minCol + 1).getValues();
      return values.map(function(rowValues) {
        const obj = {};
        headers.forEach(function(h) {
          obj[h] = rowValues[getColumnIndex_(sheetConfig, h) - minCol];
        });
        return obj;
      });
    },

    getRow: function(rowNumber, headerSubset) {
      return this.getRows({ start: rowNumber, count: 1 }, headerSubset)[0];
    },

    setColumnValidation: function(span, header, rule) {
      const col = getColumnIndex_(sheetConfig, header);
      sheet.getRange(span.start, col, span.count, 1).setDataValidation(rule);
    },

    clearColumnValidations: function(span, headers) {
      if (span.count === 0) return;
      const notations = headers.map(function(h) {
        const col = getColumnIndex_(sheetConfig, h);
        const letter = columnNumberToLetter_(col);
        return letter + span.start + ':' + letter + (span.start + span.count - 1);
      });
      if (sheet.getRangeList) {
        sheet.getRangeList(notations).clearDataValidations();
      } else {
        notations.forEach(function(n) { sheet.getRange(n).clearDataValidations(); });
      }
    },

    activateCell: function(rowNumber, header) {
      sheet.getRange(rowNumber, getColumnIndex_(sheetConfig, header)).activate();
    },

    createFilter: function() {
      const lastRow = sheet.getLastRow();
      if (lastRow <= 1) return null;
      return sheet.getRange(1, 1, lastRow, sheetConfig.headers.length).createFilter();
    },

    // Returns a Range for one column across span — for requireValueInRange validation source.
    getColumnRange: function(span, header) {
      const col = getColumnIndex_(sheetConfig, header);
      return sheet.getRange(span.start, col, span.count, 1);
    },

    // Returns a Range for rows 2..maxRows, all columns — for conditional format rules.
    getFullDataRange: function() {
      const totalRows = sheet.getMaxRows();
      return sheet.getRange(2, 1, Math.max(totalRows - 1, 1), sheetConfig.headers.length);
    },
  };
}

function resizeContiguousRows_(sheet, existingSpan, newCount) {
  if (newCount > existingSpan.count) {
    sheet.insertRowsAfter(existingSpan.start + existingSpan.count - 1, newCount - existingSpan.count);
  } else if (newCount < existingSpan.count) {
    sheet.deleteRows(existingSpan.start + newCount, existingSpan.count - newCount);
  }
  return { start: existingSpan.start, count: newCount };
}

function buildIssueLookupFormula_(rowNumber, sheetConfig) {
  const lookupCol = getColumnLetter_(sheetConfig, 'resource_name');
  const issuesConfig = FAMILY_LEDGER_SHEET_REGISTRY.issues;
  const issuesName = FAMILY_LEDGER_SHEET_NAMES.issues;
  const targetCol = getColumnLetter_(issuesConfig, 'target');
  const returnCol = getColumnLetter_(issuesConfig, 'issues_text');
  const returnIndex = getColumnIndex_(issuesConfig, 'issues_text') - getColumnIndex_(issuesConfig, 'target') + 1;
  return '=IFERROR(VLOOKUP($' + lookupCol + rowNumber + ',' + issuesName + '!$' + targetCol + ':$' + returnCol + ',' + returnIndex + ',FALSE),"")';
}

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
