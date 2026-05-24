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
    getRange(row, column, numRows, numCols) {
      return {
        getValues() {
          return Array.from({ length: numRows }, function() {
            return ['Assets:Bank:Checking', '2020-01-01', ''];
          });
        },
        getDisplayValues() {
          return Array.from({ length: numRows }, function() {
            return ['Assets:Bank:Checking', '2020-01-01', ''];
          });
        },
        row, column, numRows, numCols,
      };
    },
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
          requireValueInList() { return this; },
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

function toDateString_(v) {
  if (!v) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}

function makeDateFilterAccountsSheet(rows) {
  return {
    getLastRow() { return rows.length + 1; },
    getRange(row, column, numRows) {
      return {
        getValues() {
          return rows.slice(row - 2, row - 2 + numRows).map(function(r) { return [r[0], r[1], r[2]]; });
        },
        getDisplayValues() {
          return rows.slice(row - 2, row - 2 + numRows).map(function(r) {
            return [r[0], toDateString_(r[1]), toDateString_(r[2])];
          });
        },
      };
    },
  };
}

test('buildAccountValidationRule_ includes only currently active accounts', () => {
  const past = new Date('2020-01-01');
  const future = new Date('2099-01-01');
  const yesterday = new Date(Date.now() - 86400000);
  const tomorrow = new Date(Date.now() + 86400000);

  const accountsSheet = makeDateFilterAccountsSheet([
    ['Assets:Bank:Active', past, ''],           // active: start in past, no end
    ['Assets:Bank:Closed', past, yesterday],     // closed: end date yesterday
    ['Assets:Future:Account', tomorrow, ''],     // not yet open
    ['Assets:Bank:EndsTomorrow', past, tomorrow], // active: end date tomorrow
  ]);
  let capturedList = null;
  const { sandbox } = loadCode({
    sheetsByName: { Accounts: accountsSheet },
    SpreadsheetApp: {
      newDataValidation() {
        return {
          requireValueInList(list) { capturedList = list; return this; },
          setAllowInvalid() { return this; },
          build() { return { kind: 'rule' }; },
        };
      },
    },
  });

  sandbox.buildAccountValidationRule_();

  assert.deepEqual(capturedList, ['Assets:Bank:Active', 'Assets:Bank:EndsTomorrow']);
});

test('buildAccountValidationRule_ excludes accounts where effective_end_date is in the past', () => {
  const past = new Date('2020-01-01');
  const closedDate = new Date('2023-06-01');
  const accountsSheet = makeDateFilterAccountsSheet([
    ['Assets:Bank:Old', past, closedDate],
  ]);
  let capturedList = null;
  const { sandbox } = loadCode({
    sheetsByName: { Accounts: accountsSheet },
    SpreadsheetApp: {
      newDataValidation() {
        return {
          requireValueInList(list) { capturedList = list; return this; },
          setAllowInvalid() { return this; },
          build() { return {}; },
        };
      },
    },
  });

  const rule = sandbox.buildAccountValidationRule_();

  assert.equal(rule, null, 'rule should be null when no active accounts');
  assert.equal(capturedList, null);
});

test('buildAccountValidationRule_ excludes accounts where effective_start_date is in the future', () => {
  const future = new Date('2099-01-01');
  const accountsSheet = makeDateFilterAccountsSheet([
    ['Assets:Future', future, ''],
  ]);
  let capturedList = null;
  const { sandbox } = loadCode({
    sheetsByName: { Accounts: accountsSheet },
    SpreadsheetApp: {
      newDataValidation() {
        return {
          requireValueInList(list) { capturedList = list; return this; },
          setAllowInvalid() { return this; },
          build() { return {}; },
        };
      },
    },
  });

  const rule = sandbox.buildAccountValidationRule_();

  assert.equal(rule, null);
  assert.equal(capturedList, null);
});

test('loadAccountOptions_ caches result and skips sheet read on second call', () => {
  let readCalls = 0;
  const accountsSheet = {
    getLastRow() { readCalls++; return 3; },
    getRange(row, column, numRows) {
      return {
        getValues() {
          return [
            ['accounts/checking', 'Assets:Bank:Checking', '2020-01-01', ''],
            ['accounts/food', 'Expenses:Food', '', ''],
          ].slice(0, numRows);
        },
        getDisplayValues() {
          return [
            ['Assets:Bank:Checking', '2020-01-01', ''],
            ['Expenses:Food', '', ''],
          ].slice(0, numRows);
        },
      };
    },
  };
  const { sandbox } = loadCode({ sheetsByName: { Accounts: accountsSheet } });

  const first = sandbox.loadAccountOptions_();
  const second = sandbox.loadAccountOptions_();

  assert.equal(readCalls, 1, 'sheet should be read only once');
  assert.strictEqual(first, second, 'should return the same cached array reference');
});

test('invalidateAccountOptionsCache_ forces a fresh sheet read on the next call', () => {
  let readCalls = 0;
  const accountsSheet = {
    getLastRow() { readCalls++; return 3; },
    getRange(row, column, numRows) {
      return {
        getValues() {
          return [
            ['accounts/checking', 'Assets:Bank:Checking', '2020-01-01', ''],
            ['accounts/food', 'Expenses:Food', '', ''],
          ].slice(0, numRows);
        },
        getDisplayValues() {
          return [
            ['Assets:Bank:Checking', '2020-01-01', ''],
            ['Expenses:Food', '', ''],
          ].slice(0, numRows);
        },
      };
    },
  };
  const { sandbox } = loadCode({ sheetsByName: { Accounts: accountsSheet } });

  sandbox.loadAccountOptions_();
  assert.equal(readCalls, 1);

  sandbox.invalidateAccountOptionsCache_();
  sandbox.loadAccountOptions_();
  assert.equal(readCalls, 2, 'cache invalidation should trigger a second sheet read');
});

test('buildAccountValidationRule_ returns null when no accounts exist', () => {
  const { sandbox } = loadCode({
    sheetsByName: { Accounts: { getLastRow() { return 1; } } },
  });

  const rule = sandbox.buildAccountValidationRule_();

  assert.equal(rule, null);
});
