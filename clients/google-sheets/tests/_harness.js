const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CLIENT_DIR = path.join(__dirname, '..');

const SOURCE_FILES = [
  'Constants.js',
  'SheetLayout.js',
  'LedgerSync.js',
  'Api.js',
  'Settings.js',
  'ManagedSheetData.js',
  'TransactionsSheet.js',
  'AccountsSheet.js',
  'BalancesSheet.js',
  'DoctorIssues.js',
  'Filters.js',
  'ImporterDialog.js',
  'TransactionSave.js',
  'TransactionEdits.js',
  'App.js',
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
    console: overrides.console || console,
    SpreadsheetApp: {
      ProtectionType: { RANGE: 'RANGE' },
      BooleanCriteria: { CUSTOM_FORMULA: 'CUSTOM_FORMULA' },
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
      };
    },
    getActiveRange() {
      return { getRow() { return 2; } };
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

module.exports = {
  CLIENT_DIR,
  SOURCE_FILES,
  loadCode,
  sampleTransaction,
  makeRowStoreSheet_,
};
