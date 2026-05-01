const test = require('node:test');
const assert = require('node:assert/strict');

const { loadCode } = require('./_harness');

test('formatAccountDisplayName_ shortens canonical account names with root markers', () => {
  const { sandbox } = loadCode();

  assert.equal(sandbox.formatAccountDisplayName_('Assets:Bank:Checking'), '[A] Bank - Checking');
  assert.equal(sandbox.formatAccountDisplayName_('Expenses:Food'), '[X] Food');
  assert.equal(sandbox.formatAccountDisplayName_('Income:Salary'), '[I] Salary');
});

test('buildAccountDisplayEntries_ produces display labels for account resources', () => {
  const { sandbox } = loadCode();

  const entries = sandbox.buildAccountDisplayEntries_([
    { name: 'accounts/checking', account_name: 'Assets:Bank:Checking' },
    { name: 'accounts/food', account_name: 'Expenses:Food' },
  ]);

  assert.deepEqual(JSON.parse(JSON.stringify(entries)), [
    {
      name: 'accounts/checking',
      account_name: 'Assets:Bank:Checking',
      display_name: '[A] Bank - Checking',
    },
    {
      name: 'accounts/food',
      account_name: 'Expenses:Food',
      display_name: '[X] Food',
    },
  ]);
});

test('applyAccountValidation_ clears stale source account validation and reapplies destination dropdown only', () => {
  const operations = [];
  const accountsSheet = {
    getLastRow() { return 3; },
    getRange(row, column, numRows, numCols) {
      return { row, column, numRows, numCols };
    },
  };
  const transactionSheet = {
    getRange(row, column, numRows = 1, numCols = 1) {
      return {
        clearDataValidations() {
          operations.push({ type: 'clearDataValidations', row, column, numRows, numCols });
          return this;
        },
        setDataValidation(rule) {
          operations.push({ type: 'setDataValidation', row, column, numRows, numCols, hasRule: Boolean(rule) });
          return this;
        },
      };
    },
  };
  const { sandbox } = loadCode({
    sheetsByName: {
      Accounts: accountsSheet,
    },
    SpreadsheetApp: {
      newDataValidation() {
        return {
          requireValueInRange() { return this; },
          setAllowInvalid() { return this; },
          build() { return { kind: 'rule' }; },
        };
      },
    },
  });

  sandbox.applyAccountValidation_(transactionSheet, 4);

  assert.deepEqual(operations, [
    { type: 'clearDataValidations', row: 2, column: 6, numRows: 4, numCols: 1 },
    { type: 'clearDataValidations', row: 2, column: 7, numRows: 4, numCols: 1 },
    { type: 'setDataValidation', row: 2, column: 7, numRows: 4, numCols: 1, hasRule: true },
  ]);
});

test('refreshTransactionAccountValidation_ clears stale transaction account dropdowns during layout reset', () => {
  const operations = [];
  const transactionSheet = {
    getLastRow() { return 4; },
    getRange(row, column, numRows = 1, numCols = 1) {
      return {
        clearDataValidations() {
          operations.push({ type: 'clearDataValidations', row, column, numRows, numCols });
          return this;
        },
        setDataValidation(rule) {
          operations.push({ type: 'setDataValidation', row, column, numRows, numCols, hasRule: Boolean(rule) });
          return this;
        },
      };
    },
  };
  const { sandbox } = loadCode({
    sheetsByName: {
      Accounts: { getLastRow() { return 1; } },
    },
  });

  sandbox.refreshTransactionAccountValidation_(transactionSheet);

  assert.deepEqual(operations, [
    { type: 'clearDataValidations', row: 2, column: 6, numRows: 3, numCols: 1 },
    { type: 'clearDataValidations', row: 2, column: 7, numRows: 3, numCols: 1 },
  ]);
});
