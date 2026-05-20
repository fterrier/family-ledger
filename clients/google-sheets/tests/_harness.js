const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CLIENT_DIR = path.join(__dirname, '..');

const SOURCE_FILES = [
  'Constants.js',
  'Perf.js',
  'SheetLayout.js',
  'Entity.js',
  'Transaction.js',
  'LedgerSync.js',
  'Api.js',
  'Settings.js',
  'ManagedSheet.js',
  'AccountsSheet.js',
  'BalancesSheet.js',
  'DoctorIssues.js',
  'Filters.js',
  'ImporterDialogs.js',
  'App.js',
  'SheetSettings.js',
  'Sidebar.js',
  'AccountSearch.html',
  'SearchDropdown.html',
];

function loadCode(overrides = {}) {
  const properties = new Map();
  const documentProperties = new Map();
  const fetchCalls = [];
  const source = SOURCE_FILES
    .map((name) => fs.readFileSync(path.join(CLIENT_DIR, name), 'utf8'))
    .join('\n');

  const sandbox = {
    JSON,
    BigInt,
    Math,
    Date,
    String,
    Number,
    Boolean,
    Array,
    Object,
    RegExp,
    Error,
    encodeURIComponent,
    setTimeout: overrides.setTimeout || undefined,
    clearTimeout: overrides.clearTimeout || undefined,
    console: overrides.console || console,
    SpreadsheetApp: {
      ProtectionType: { RANGE: 'RANGE' },
      BooleanCriteria: { CUSTOM_FORMULA: 'CUSTOM_FORMULA' },
      flush() {},
      getUi() {
        throw new Error('Unexpected SpreadsheetApp.getUi() call in unit test');
      },
      newRichTextValue() {
        return {
          text: '',
          style: null,
          setText(value) {
            this.text = value;
            return this;
          },
          setTextStyle(_start, _end, style) {
            this.style = style;
            return this;
          },
          build() {
            return { text: this.text, style: this.style };
          },
        };
      },
      newTextStyle() {
        return {
          bold: false,
          setBold(value) {
            this.bold = value;
            return this;
          },
          build() {
            return { bold: this.bold };
          },
        };
      },
      newDataValidation() {
        return {
          requireValueInRange() {
            return this;
          },
          requireCheckbox() {
            return this;
          },
          setAllowInvalid() {
            return this;
          },
          build() {
            return {};
          },
        };
      },
      newConditionalFormatRule() {
        const rule = {
          formula: '',
          background: '',
          italic: null,
          ranges: [],
          whenFormulaSatisfied(value) {
            this.formula = value;
            return this;
          },
          setBackground(value) {
            this.background = value;
            return this;
          },
          setItalic(value) {
            this.italic = value;
            return this;
          },
          setRanges(value) {
            this.ranges = value;
            return this;
          },
          build() {
            return {
              getBooleanCondition() {
                return {
                  getCriteriaType() {
                    return 'CUSTOM_FORMULA';
                  },
                  getCriteriaValues() {
                    return [rule.formula];
                  },
                };
              },
              formula: rule.formula,
              background: rule.background,
              italic: rule.italic,
              ranges: rule.ranges,
            };
          },
        };
        return rule;
      },
      newFilterCriteria() {
        let _formula = null;
        return {
          whenFormulaSatisfied(f) { _formula = f; return this; },
          build() { return { formula: _formula }; },
        };
      },
      getActiveSpreadsheet() {
        return {
          getSheetByName(name) {
            return (overrides.sheetsByName || {})[name] || null;
          },
          insertSheet(name) {
            return {
              getName() { return name; },
              getLastRow() { return 1; },
              getMaxRows() { return 1; },
              getMaxColumns() { return 1; },
              getRange() {
                return {
                  getValues() { return []; },
                  setValues() { return this; },
                  clearContents() {},
                  setFormulas() {},
                };
              },
              clearContents() {},
              setFrozenRows() {},
              hideSheet() {},
              isSheetHidden() { return false; },
              getSheetId() { return 0; },
            };
          },
        };
      },
      ...overrides.SpreadsheetApp,
    },
    ScriptApp: {
      getProjectTriggers() {
        return [];
      },
      newTrigger() {
        return {
          forSpreadsheet() {
            return this;
          },
          onEdit() {
            return this;
          },
          create() {
            return {};
          },
        };
      },
      ...overrides.ScriptApp,
    },
    PropertiesService: {
      getScriptProperties() {
        return {
          getProperty(key) {
            return properties.has(key) ? properties.get(key) : null;
          },
          setProperty(key, value) {
            properties.set(key, value);
          },
        };
      },
      getDocumentProperties() {
        return {
          getProperty(key) {
            return documentProperties.has(key) ? documentProperties.get(key) : null;
          },
          getProperties() {
            const result = {};
            documentProperties.forEach(function(value, key) { result[key] = value; });
            return result;
          },
          setProperty(key, value) {
            documentProperties.set(key, value);
          },
          deleteProperty(key) {
            documentProperties.delete(key);
          },
          has(key) {
            return documentProperties.has(key);
          },
          get(key) {
            return documentProperties.get(key);
          },
          set(key, value) {
            documentProperties.set(key, value);
          },
        };
      },
      ...overrides.PropertiesService,
    },
    UrlFetchApp: {
      fetch(url, options) {
        fetchCalls.push({ url, options });
        if (overrides.fetchImpl) {
          return overrides.fetchImpl(url, options);
        }
        return {
          getResponseCode() {
            return 200;
          },
          getContentText() {
            return '{}';
          },
        };
      },
    },
    Utilities: {
      formatDate(value) {
        return value.toISOString().slice(0, 10);
      },
      sleep(_ms) {},
      ...overrides.Utilities,
    },
    HtmlService: {
      createHtmlOutputFromFile() {
        throw new Error('Unexpected HtmlService.createHtmlOutputFromFile() call in unit test');
      },
      createTemplateFromFile() {
        throw new Error('Unexpected HtmlService.createTemplateFromFile() call in unit test');
      },
      ...overrides.HtmlService,
    },
  };

  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'family-ledger-sheets' });
  return { sandbox, properties, documentProperties, fetchCalls };
}

function sampleTransaction(overrides = {}) {
  return {
    name: 'transactions/txn_1',
    transaction_date: '2026-04-19',
    payee: 'Migros',
    narration: 'Groceries',
    postings: [
      { account: 'accounts/source', units: { amount: '-84.25', symbol: 'CHF' } },
      { account: 'accounts/food', units: { amount: '84.25', symbol: 'CHF' } },
    ],
    ...overrides,
  };
}

function makeRowStoreSheet_(sandbox, rowStore, operations) {
  const headers = sandbox.getSheetConfigByName_('Transactions').headers;
  let filterCriteriaByColumn = null;
  return {
    getLastRow() {
      return rowStore.size === 0 ? 1 : Math.max(...rowStore.keys());
    },
    getMaxRows() {
      return this.getLastRow();
    },
    getRange(row, column, numRows = 1, numCols = 1) {
      return {
        getValue() {
          const rowData = rowStore.get(row) || {};
          return rowData[headers[column - 1]] || '';
        },
        setValue(value) {
          operations.push({ type: 'setValue', row, column, value });
          const rowData = { ...(rowStore.get(row) || {}) };
          rowData[headers[column - 1]] = value;
          rowStore.set(row, rowData);
          return this;
        },
        getValues() {
          const values = [];
          for (let rowIndex = 0; rowIndex < numRows; rowIndex += 1) {
            const rowData = rowStore.get(row + rowIndex) || {};
            const rowValues = [];
            for (let colIndex = 0; colIndex < numCols; colIndex += 1) {
              rowValues.push(rowData[headers[column + colIndex - 1]] || '');
            }
            values.push(rowValues);
          }
          return values;
        },
        setValues(valueRows) {
          valueRows.forEach((valueRow, rowIndex) => {
            const rowData = { ...(rowStore.get(row + rowIndex) || {}) };
            valueRow.forEach((value, colIndex) => {
              rowData[headers[column + colIndex - 1]] = value;
            });
            rowStore.set(row + rowIndex, rowData);
          });
          return this;
        },
        setFormula(value) {
          operations.push({ type: 'setFormula', row, column, value });
          return this;
        },
        setHorizontalAlignment() { return this; },
        setWrap() { return this; },
        setWrapStrategy() { return this; },
        setNumberFormat() { return this; },
        setDataValidation() { return this; },
        clearDataValidations() { return this; },
        setNote() { return this; },
        setBackground() { return this; },
        setFontWeight() { return this; },
        setFormulas() { return this; },
        createFilter() {
          operations.push({ type: 'createFilter', row, column, numRows, numCols });
          filterCriteriaByColumn = {};
          return {
            setColumnFilterCriteria(columnIndex, criteria) {
              filterCriteriaByColumn[columnIndex] = criteria;
            },
          };
        },
        activate() {
          operations.push({ type: 'activate', row, column });
        },
      };
    },
    getRangeList(notations) {
      return {
        setBackground() { operations.push({ type: 'rangeListBackground', notations }); return this; },
        setFontWeight() { operations.push({ type: 'rangeListFontWeight', notations }); return this; },
        setHorizontalAlignment(value) { operations.push({ type: 'rangeListAlign', notations, value }); return this; },
        setWrap(value) { operations.push({ type: 'rangeListWrap', notations, value }); return this; },
        setWrapStrategy(value) { operations.push({ type: 'rangeListWrapStrategy', notations, value }); return this; },
        setNumberFormat(value) { operations.push({ type: 'rangeListNumberFormat', notations, value }); return this; },
        clearDataValidations() { operations.push({ type: 'rangeListClearValidations', notations }); return this; },
      };
    },
    getActiveRange() {
      return { getRow() { return 2; } };
    },
    insertRowsBefore(rowNumber, count) {
      operations.push({ type: 'insertRowsBefore', rowNumber, count });
      const entries = Array.from(rowStore.entries()).sort((a, b) => b[0] - a[0]);
      entries.forEach(([existingRowNumber, data]) => {
        if (existingRowNumber >= rowNumber) {
          rowStore.delete(existingRowNumber);
          rowStore.set(existingRowNumber + count, data);
        }
      });
    },
    insertRowsAfter(rowNumber, count) {
      operations.push({ type: 'insertRowsAfter', rowNumber, count });
      const entries = Array.from(rowStore.entries()).sort((a, b) => b[0] - a[0]);
      entries.forEach(([existingRowNumber, data]) => {
        if (existingRowNumber > rowNumber) {
          rowStore.delete(existingRowNumber);
          rowStore.set(existingRowNumber + count, data);
        }
      });
    },
    deleteRow(rowNumber) {
      operations.push({ type: 'deleteRow', rowNumber });
      rowStore.delete(rowNumber);
      const entries = Array.from(rowStore.entries()).sort((a, b) => a[0] - b[0]);
      entries.forEach(([existingRowNumber, data]) => {
        if (existingRowNumber > rowNumber) {
          rowStore.delete(existingRowNumber);
          rowStore.set(existingRowNumber - 1, data);
        }
      });
    },
    deleteRows(startRow, count) {
      operations.push({ type: 'deleteRows', startRow, count });
      for (let i = 0; i < count; i += 1) rowStore.delete(startRow + i);
      const entries = Array.from(rowStore.entries()).sort((a, b) => a[0] - b[0]);
      entries.forEach(([existingRowNumber, data]) => {
        if (existingRowNumber >= startRow + count) {
          rowStore.delete(existingRowNumber);
          rowStore.set(existingRowNumber - count, data);
        }
      });
    },
    clearContents() { operations.push({ type: 'clearContents' }); },
    setFrozenRows() {},
    getName() { return 'Transactions'; },
    setColumnWidth() {},
    getFilter() {
      if (!filterCriteriaByColumn) {
        return null;
      }
      return {
        getColumnFilterCriteria(column) {
          return filterCriteriaByColumn[column] || null;
        },
        setColumnFilterCriteria(column, criteria) {
          filterCriteriaByColumn[column] = criteria;
        },
        removeColumnFilterCriteria(column) {
          delete filterCriteriaByColumn[column];
        },
        remove() {
          filterCriteriaByColumn = null;
        },
      };
    },
    getConditionalFormatRules() { return []; },
    setConditionalFormatRules(rules) {
      operations.push({ type: 'setConditionalFormatRules', rules });
    },
    protect() { return { removeEditors() {}, addEditor() {}, setWarningOnly() {} }; },
    hideColumns() {},
  };
}

// Minimal fake sheet for unit-testing managedSheet_ in isolation.
// getValuesFn(row, col, numRows, numCols) controls what getValues() returns.
function makeFakeSheet_(getValuesFn) {
  const calls = [];
  const rangeListCalls = [];

  function makeRange(row, col, numRows, numCols) {
    return {
      getValues() {
        return getValuesFn ? getValuesFn(row, col, numRows, numCols) : [];
      },
      setValues(values) {
        calls.push({ method: 'setValues', row, col, numRows, numCols, values });
        return this;
      },
      setFormulas(formulas) {
        calls.push({ method: 'setFormulas', row, col, numRows, numCols, formulas });
        return this;
      },
      setDataValidation(rule) {
        calls.push({ method: 'setDataValidation', row, col, numRows, numCols, rule });
        return this;
      },
      clearDataValidations() {
        calls.push({ method: 'clearDataValidations', row, col, numRows, numCols });
        return this;
      },
      createFilter() {
        calls.push({ method: 'createFilter', row, col, numRows, numCols });
        return { filterSentinel: true };
      },
      activate() {
        calls.push({ method: 'activate', row, col });
      },
    };
  }

  return {
    calls,
    rangeListCalls,
    getLastRow() { return 10; },
    getMaxRows() { return 10; },
    getRange(row, col, numRows = 1, numCols = 1) {
      return makeRange(row, col, numRows, numCols);
    },
    getRangeList(notations) {
      rangeListCalls.push({ notations });
      return {
        clearDataValidations() {
          calls.push({ method: 'rangeListClearDataValidations', notations });
          return this;
        },
      };
    },
  };
}

module.exports = {
  CLIENT_DIR,
  SOURCE_FILES,
  loadCode,
  sampleTransaction,
  makeRowStoreSheet_,
  makeFakeSheet_,
};
