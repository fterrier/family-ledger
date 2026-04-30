const test = require('node:test');
const assert = require('node:assert/strict');

const { loadCode, sampleTransaction, makeRowStoreSheet_ } = require('./_harness');

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

  assert.equal(rows[0].issues, 'transaction_unbalanced (CHF, residual -4.25, tolerance 0.005)');
});

test('applyFetchedDoctorIssuesToExistingSheet_ clears stale issues and reapplies row highlighting', () => {
  const operations = [];
  const rowStore = new Map([[2, {
    transaction_name: 'transactions/txn_1',
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

  sandbox.applyFetchedDoctorIssuesToExistingSheet_(fakeSheet, {});

  assert.equal(rowStore.get(2).issues, '');
});

test('refreshTransactionIssuesFromDoctor_ updates issues asynchronously without touching status', () => {
  const operations = [];
  const rowStore = new Map([[2, {
    transaction_name: 'transactions/txn_1',
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

  function makeSimpleSheet() {
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

  const doctorTransactionSheet = makeSimpleSheet();
  const doctorAccountSheet = makeSimpleSheet();
  const sheetsByName = {
    DoctorTransactionIssues: doctorTransactionSheet,
    DoctorAccountIssues: doctorAccountSheet,
  };
  const { sandbox } = loadCode({
    SpreadsheetApp: {
      getActiveSpreadsheet() {
        return {
          getSheetByName(name) {
            return sheetsByName[name] || null;
          },
          insertSheet(name) {
            const sheet = makeRowStoreSheet_(sandbox, new Map(), []);
            sheetsByName[name] = sheet;
            return sheet;
          },
          toast() {},
        };
      },
    },
  });
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, operations);

  sandbox.apiFetchJson_ = function(method, resourcePath) {
    if (method === 'post' && resourcePath === '/ledger:doctor') {
      return {
        issues: [{
          target: 'transactions/txn_1',
          code: 'transaction_unbalanced',
          message: 'Transaction is not balanced within tolerance.',
          details: { symbol: 'CHF', residual_amount: '-4.25', tolerance_amount: '0.005' },
        }],
      };
    }
    throw new Error('unexpected api call');
  };

  sandbox.refreshTransactionIssuesFromDoctor_(fakeSheet);

  assert.equal(doctorTransactionSheet.getLastRow(), 2);
  assert.equal(rowStore.get(2).status, 'saved');
  assert.equal(rowStore.get(2).last_error, '');
});
