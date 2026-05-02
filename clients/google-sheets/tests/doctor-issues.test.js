const test = require('node:test');
const assert = require('node:assert/strict');

const { loadCode, sampleTransaction, makeRowStoreSheet_ } = require('./_harness');

function makeSimpleHiddenSheet() {
  let lastRow = 1;
  let hidden = false;
  return {
    getLastRow() { return lastRow; },
    clearContents() { lastRow = 1; },
    getRange(row) {
      return {
        setValues(values) {
          lastRow = Math.max(lastRow, row + values.length - 1);
        },
      };
    },
    hideSheet() { hidden = true; },
    isSheetHidden() { return hidden; },
  };
}

function makeAccountRowStoreSheet(sandbox, rowStore, operations) {
  const headers = sandbox.getSheetConfigByName_('Accounts').headers;
  return {
    getLastRow() {
      return rowStore.size === 0 ? 1 : Math.max(...rowStore.keys());
    },
    getName() { return 'Accounts'; },
    getRange(row, column, numRows = 1, numCols = 1) {
      return {
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
        setValue(value) {
          operations.push({ type: 'setValue', row, column, value });
          const rowData = { ...(rowStore.get(row) || {}) };
          rowData[headers[column - 1]] = value;
          rowStore.set(row, rowData);
          return this;
        },
      };
    },
  };
}

test('mergeDoctorIssuesIntoRows_ merges doctor issues onto every transaction row', () => {
  const { sandbox } = loadCode();

  const rows = sandbox.flattenTransactionForSheet_(sampleTransaction(), {
    'accounts/source': 'Assets:Bank:Checking',
    'accounts/food': 'Expenses:Food',
  });

  sandbox.mergeDoctorIssuesIntoRows_(rows, {
    'transactions/txn_1': [{
      target: 'transactions/txn_1',
      code: 'transaction_unbalanced',
      message: 'Transaction is not balanced within tolerance.',
      details: { symbol: 'CHF', residual_amount: '-4.25', tolerance_amount: '0.005' },
    }],
  });

  assert.equal(
    rows[0].issues,
    'transaction_unbalanced: Transaction is not balanced within tolerance. (residual_amount -4.25, symbol CHF, tolerance_amount 0.005)'
  );
});

test('formatDoctorIssuesForSheet_ includes generic issue details for all codes', () => {
  const { sandbox } = loadCode();

  assert.equal(
    sandbox.formatDoctorIssuesForSheet_([{
      target: 'transactions/txn_1',
      code: 'lot_match_missing',
      message: 'Not enough lots to reduce.',
      details: {
        requested_amount: '15',
        available_amount: '10',
        units_symbol: 'AAPL',
      },
    }]),
    'lot_match_missing: Not enough lots to reduce. (available_amount 10, requested_amount 15, units_symbol AAPL)'
  );
});

test('applyDoctorIssuesToVisibleSheet_ clears stale transaction issues', () => {
  const operations = [];
  const rowStore = new Map([[2, {
    resource_name: 'transactions/txn_1',
    transaction_date: '2026-04-19',
    payee: 'Migros',
    narration: 'Groceries',
    source_account_name: 'Assets:Bank:Checking',
    destination_account_name: 'Expenses:Food',
    amount: 84.25,
    split_off_amount: '',
    symbol: 'CHF',
    status: 'saved',
    issues: 'transaction_unbalanced (CHF, residual -4.25, tolerance 0.005)',
    last_error: '',
  }]]);
  const { sandbox } = loadCode();
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, operations);

  sandbox.applyDoctorIssuesToVisibleSheet_(fakeSheet, {});

  assert.equal(rowStore.get(2).issues, '');
});

test('refreshVisibleLedgerIssuesFromDoctor_ updates issues across transactions and accounts', () => {
  const transactionOperations = [];
  const accountOperations = [];
  const transactionRowStore = new Map([[2, {
    resource_name: 'transactions/txn_1',
    transaction_date: '2026-04-19',
    payee: 'Migros',
    narration: 'Groceries',
    source_account_name: 'Assets:Bank:Checking',
    destination_account_name: 'Expenses:Food',
    amount: 84.25,
    split_off_amount: '',
    symbol: 'CHF',
    status: 'saved',
    issues: '',
    last_error: '',
  }]]);
  const accountRowStore = new Map([[2, {
    resource_name: 'accounts/food',
    account_name: '[X] Food',
    issues: 'stale',
  }]]);

  const doctorTransactionSheet = makeSimpleHiddenSheet();
  const doctorAccountSheet = makeSimpleHiddenSheet();
  const sheetsByName = {
    DoctorTransactionIssues: doctorTransactionSheet,
    DoctorAccountIssues: doctorAccountSheet,
    Transactions: null,
    Accounts: null,
  };
  const { sandbox } = loadCode({
    SpreadsheetApp: {
      getActiveSpreadsheet() {
        return {
          getSheetByName(name) {
            return sheetsByName[name] || null;
          },
          insertSheet(name) {
            const sheet = makeSimpleHiddenSheet();
            sheetsByName[name] = sheet;
            return sheet;
          },
          toast() {},
        };
      },
    },
  });
  const transactionSheet = makeRowStoreSheet_(sandbox, transactionRowStore, transactionOperations);
  const accountSheet = makeAccountRowStoreSheet(sandbox, accountRowStore, accountOperations);
  sheetsByName.Transactions = transactionSheet;
  sheetsByName.Accounts = accountSheet;

  sandbox.apiFetchJson_ = function(method, resourcePath) {
    if (method === 'post' && resourcePath === '/ledger:doctor') {
      return {
        issues: [
          {
            target: 'transactions/txn_1',
            code: 'transaction_unbalanced',
            message: 'Transaction is not balanced within tolerance.',
            details: { symbol: 'CHF', residual_amount: '-4.25', tolerance_amount: '0.005' },
          },
          {
            target: 'accounts/food',
            code: 'account_warning',
            message: 'Account needs attention.',
            details: { severity: 'warning' },
          },
          {
            target: 'commodities/chf',
            code: 'unsupported_target',
            message: 'Ignored by sheets.',
            details: {},
          },
        ],
      };
    }
    throw new Error('unexpected api call');
  };

  sandbox.refreshVisibleLedgerIssuesFromDoctor_();

  assert.equal(doctorTransactionSheet.getLastRow(), 2);
  assert.equal(doctorAccountSheet.getLastRow(), 2);
  assert.equal(transactionRowStore.get(2).status, 'saved');
  assert.equal(transactionRowStore.get(2).last_error, '');
  assert.equal(
    transactionRowStore.get(2).issues,
    'transaction_unbalanced: Transaction is not balanced within tolerance. (residual_amount -4.25, symbol CHF, tolerance_amount 0.005)'
  );
  assert.equal(
    accountRowStore.get(2).issues,
    'account_warning: Account needs attention. (severity warning)'
  );
});
