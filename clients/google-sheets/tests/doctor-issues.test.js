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

test('buildIssueLookupFormula_ derives lookup column from sheet config resource_name position', () => {
  const { sandbox } = loadCode();
  const txConfig = sandbox.getSheetConfigByName_('Transactions');
  assert.equal(
    sandbox.buildIssueLookupFormula_(5, txConfig),
    '=IFERROR(VLOOKUP($B5,Issues!$A:$D,4,FALSE),"")'
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
        target_summary: { date: '2026-05-22', payee: 'Migros' },
      }],
      'accounts/food': [{
        target: 'accounts/food',
        code: 'account_warning',
        message: 'Account needs attention.',
        details: { severity: 'warning' },
        target_summary: {},
      }],
    },
    function() { return issueSheet; },
    {}
  );

  // setValuesCalls[0] = header row; setValuesCalls[1] = data rows
  const dataCall = setValuesCalls.find(function(c) { return c.row === 2 && c.col === 1; });
  assert.ok(dataCall, 'data rows must be written to Issues sheet');
  // rows are sorted alphabetically by resource name (stable order required for VLOOKUP)
  assert.equal(dataCall.values[0][0], 'accounts/food');        // column A: target
  assert.equal(dataCall.values[0][3], 'Account needs attention. (severity warning)');   // column D: issues_text
  assert.equal(dataCall.values[1][0], 'transactions/txn_1');   // column A: target
  assert.equal(dataCall.values[1][3], 'Transaction is not balanced within tolerance. (residual_amount -4.25, symbol CHF, tolerance_amount 0.005)'); // column D: issues_text
});

test('writeFetchedDoctorIssueSheets_ navigate formula uses resource_name column of target sheet', () => {
  const setValuesCalls = [];
  const issueSheet = {
    getLastRow() { return 1; },
    getMaxColumns() { return 4; },
    getMaxRows() { return 10; },
    clearContents() {},
    getRange(row, col, numRows = 1, numCols = 1) {
      return { setValues(values) { setValuesCalls.push({ row, values }); return this; } };
    },
  };
  const txSheet = { getSheetId() { return 42; } };
  const balSheet = { getSheetId() { return 43; } };

  const { sandbox } = loadCode({
    SpreadsheetApp: {
      getActiveSpreadsheet() {
        return {
          getSheetByName(name) {
            if (name === 'Transactions') return txSheet;
            if (name === 'Balances') return balSheet;
            return null;
          },
        };
      },
    },
  });

  sandbox.writeFetchedDoctorIssueSheets_(
    {
      'transactions/txn_1': [{ target: 'transactions/txn_1', code: 'x', message: 'msg', details: {}, target_summary: { date: '2026-05-22', payee: 'Coop' } }],
      'balanceAssertions/bal_1': [{ target: 'balanceAssertions/bal_1', code: 'x', message: 'msg', details: {}, target_summary: { date: '2026-04-01', account: 'Assets:Bank' } }],
    },
    function() { return issueSheet; },
    {}
  );

  const dataCall = setValuesCalls.find(function(c) { return c.row === 2; });
  // rows are sorted alphabetically: balanceAssertions/bal_1 before transactions/txn_1
  const balNavigate = dataCall.values[0][1]; // column B (navigate)
  const txNavigate = dataCall.values[1][1];

  // Transactions: resource_name is column B ($B:$B), first visible is column A (edit)
  assert.ok(txNavigate.includes('$B:$B'), 'transaction MATCH should search resource_name column B');
  assert.ok(txNavigate.includes('range=A'), 'transaction link should navigate to first visible column A');
  assert.ok(txNavigate.includes('gid=42'), 'transaction link should use transactions sheet gid');

  // Balances: resource_name is column B ($B:$B), first visible is column A (edit)
  assert.ok(balNavigate.includes('$B:$B'), 'balance MATCH should search resource_name column B');
  assert.ok(balNavigate.includes('range=A'), 'balance link should navigate to first visible column A');
  assert.ok(balNavigate.includes('gid=43'), 'balance link should use balances sheet gid');

  // Labels from target_summary
  assert.ok(txNavigate.includes('Transaction 2026-05-22 Coop'), 'transaction label uses target_summary date and payee');
  assert.ok(balNavigate.includes('Balance 2026-04-01 Assets:Bank'), 'balance label uses target_summary date and account');
});

test('buildNavigateLabel_ builds label from target_summary for each target type', () => {
  const { sandbox } = loadCode();
  const accountMap = { 'accounts/food': 'Food & Dining' };

  assert.equal(
    sandbox.buildNavigateLabel_('transactions/txn_1', { date: '2026-05-22', payee: 'Migros' }, {}),
    'Transaction 2026-05-22 Migros'
  );
  assert.equal(
    sandbox.buildNavigateLabel_('transactions/txn_2', { date: '2026-01-15' }, {}),
    'Transaction 2026-01-15'
  );
  assert.equal(
    sandbox.buildNavigateLabel_('balanceAssertions/ba_1', { date: '2026-04-01', account: 'Assets:Bank:Checking' }, {}),
    'Balance 2026-04-01 Assets:Bank:Checking'
  );
  assert.equal(
    sandbox.buildNavigateLabel_('attachments/att_1', { date: '2026-03-10', account: 'Expenses:Food' }, {}),
    'Attachment 2026-03-10 Expenses:Food'
  );
  assert.equal(
    sandbox.buildNavigateLabel_('accounts/food', {}, accountMap),
    'Account Food & Dining'
  );
  assert.equal(
    sandbox.buildNavigateLabel_('accounts/unknown/sub', {}, {}),
    'Account unknown/sub'
  );
  assert.equal(
    sandbox.buildNavigateLabel_('unknown/resource', {}, {}),
    'unknown/resource'
  );
});

test('refreshDoctorIssueSheets_ groups fetched issues by target and passes them to write', () => {
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

  sandbox.refreshDoctorIssueSheets_();

  assert.equal(writeCalls.length, 1);
  assert.equal(writeCalls[0].targetCount, 2);
});
