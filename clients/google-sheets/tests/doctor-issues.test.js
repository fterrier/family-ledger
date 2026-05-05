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
    'Transaction is not balanced within tolerance. (residual_amount -4.25, symbol CHF, tolerance_amount 0.005)'
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
    'Not enough lots to reduce. (available_amount 10, requested_amount 15, units_symbol AAPL)'
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

test('buildIssueLookupFormula_ generates VLOOKUP referencing Issues sheet column 4', () => {
  const { sandbox } = loadCode();
  assert.equal(
    sandbox.buildIssueLookupFormula_(5),
    '=IFERROR(VLOOKUP($A5,Issues!$A:$D,4,FALSE),"")'
  );
});

test('writeFetchedDoctorIssueSheets_ writes target and issues_text to Issues sheet for VLOOKUP', () => {
  const setValuesCalls = [];
  const issueSheet = {
    getLastRow() { return 1; },
    getMaxColumns() { return 4; },
    getMaxRows() { return 10; },
    clearContents() {},
    getRange(row, col, numRows = 1, numCols = 1) {
      return {
        setValues(values) {
          setValuesCalls.push({ row, col, numRows, numCols, values });
          return this;
        },
      };
    },
    getSheetId() { return 99; },
  };

  const { sandbox } = loadCode({
    SpreadsheetApp: {
      getActiveSpreadsheet() {
        return { getSheetByName() { return null; } };
      },
    },
  });

  sandbox.writeFetchedDoctorIssueSheets_(
    {
      'transactions/txn_1': [{
        target: 'transactions/txn_1',
        code: 'transaction_unbalanced',
        message: 'Transaction is not balanced within tolerance.',
        details: { symbol: 'CHF', residual_amount: '-4.25', tolerance_amount: '0.005' },
      }],
      'accounts/food': [{
        target: 'accounts/food',
        code: 'account_warning',
        message: 'Account needs attention.',
        details: { severity: 'warning' },
      }],
    },
    function() { return issueSheet; }
  );

  // setValuesCalls[0] = header row; setValuesCalls[1] = data rows
  const dataCall = setValuesCalls.find(function(c) { return c.row === 2 && c.col === 1; });
  assert.ok(dataCall, 'data rows must be written to Issues sheet');
  // rows are sorted alphabetically by target
  assert.equal(dataCall.values[0][0], 'accounts/food');     // column A: target
  assert.equal(dataCall.values[0][3], 'Account needs attention. (severity warning)');   // column D: issues_text
  assert.equal(dataCall.values[1][0], 'transactions/txn_1'); // column A: target
  assert.equal(dataCall.values[1][3], 'Transaction is not balanced within tolerance. (residual_amount -4.25, symbol CHF, tolerance_amount 0.005)'); // column D: issues_text
});

test('refreshVisibleLedgerIssuesFromDoctor_ writes Issues sheet without modifying visible rows inline', () => {
  const writeCalls = [];
  const { sandbox } = loadCode({
    SpreadsheetApp: {
      getActiveSpreadsheet() {
        return {
          getSheetByName() { return null; },
          toast() {},
        };
      },
    },
  });

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

  sandbox.writeFetchedDoctorIssueSheets_ = function(issuesByTarget) {
    writeCalls.push({ targetCount: Object.keys(issuesByTarget).length });
  };

  sandbox.refreshVisibleLedgerIssuesFromDoctor_();

  assert.equal(writeCalls.length, 1);
  assert.equal(writeCalls[0].targetCount, 2);
});
