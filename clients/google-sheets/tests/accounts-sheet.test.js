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
      resource_name: 'accounts/checking',
      account_name: 'Assets:Bank:Checking',
      display_name: '[A] Bank - Checking',
    },
    {
      resource_name: 'accounts/food',
      account_name: 'Expenses:Food',
      display_name: '[X] Food',
    },
  ]);
});

test('refreshAccountValidation_ applies account dropdown to validation:account columns', () => {
  const operations = [];
  const accountsSheet = {
    getLastRow() { return 3; },
    getRange(row, column, numRows, numCols) { return { row, column, numRows, numCols }; },
  };
  const transactionSheet = {
    getLastRow() { return 5; },
    getRange(row, column, numRows = 1, numCols = 1) {
      return {
        setDataValidation(rule) {
          operations.push({ type: 'setDataValidation', column, numRows, hasRule: Boolean(rule) });
          return this;
        },
      };
    },
  };
  const { sandbox } = loadCode({
    sheetsByName: { Accounts: accountsSheet },
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

  sandbox.refreshAccountValidation_(transactionSheet, sandbox.getSheetConfigByName_('Transactions'));

  assert.deepEqual(JSON.parse(JSON.stringify(operations)), [
    { type: 'setDataValidation', column: 8, numRows: 4, hasRule: true },
  ]);
});

test('refreshAccountValidation_ is a no-op for sheets with no validation:account columns', () => {
  const operations = [];
  const sheet = {
    getLastRow() { return 5; },
    getRange() { operations.push('getRange'); return {}; },
  };
  const { sandbox } = loadCode();

  sandbox.refreshAccountValidation_(sheet, sandbox.getSheetConfigByName_('Balances'));

  assert.deepEqual(operations, []);
});

test('refreshAccountValidation_ clears validation when no accounts exist', () => {
  const operations = [];
  const transactionSheet = {
    getLastRow() { return 3; },
    getRangeList(notations) {
      return { clearDataValidations() { operations.push({ type: 'rangeListClear', notations }); return this; } };
    },
    getRange() { return {}; },
  };
  const { sandbox } = loadCode({
    sheetsByName: { Accounts: { getLastRow() { return 1; } } },
  });

  sandbox.refreshAccountValidation_(transactionSheet, sandbox.getSheetConfigByName_('Transactions'));

  assert.deepEqual(JSON.parse(JSON.stringify(operations)), [
    { type: 'rangeListClear', notations: ['H2:H3'] },
  ]);
});
