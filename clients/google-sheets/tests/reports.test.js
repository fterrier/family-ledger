const test = require('node:test');
const assert = require('node:assert/strict');

const { loadCode, makeRowStoreSheet_ } = require('./_harness');

function makeTxnRowStore_(rows) {
  const rowStore = new Map();
  rows.forEach(function(row, i) {
    rowStore.set(i + 2, row);
  });
  return rowStore;
}

function withTxnSheet_(sandbox, rows) {
  const rowStore = makeTxnRowStore_(rows);
  const mockSheet = makeRowStoreSheet_(sandbox, rowStore, []);
  sandbox.SpreadsheetApp.getActiveSpreadsheet = function() {
    return {
      getSheetByName(name) { return name === 'Transactions' ? mockSheet : null; },
      getSpreadsheetTimeZone() { return 'UTC'; },
    };
  };
}

test('checkSourceAccountWarnings_: warns when source_account_name exactly equals displayName', function() {
  const { sandbox } = loadCode();
  withTxnSheet_(sandbox, [
    { transaction_date: '2023-05-01', source_account_name: '[X] Family' },
  ]);

  const warnings = sandbox.checkSourceAccountWarnings_('[X] Family');
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('[X] Family'));
  assert.ok(warnings[0].includes('2023-05-01'));
});

test('checkSourceAccountWarnings_: warns when source_account_name is a child account', function() {
  const { sandbox } = loadCode();
  withTxnSheet_(sandbox, [
    { transaction_date: '2024-01-15', source_account_name: '[X] Family - Food' },
  ]);

  const warnings = sandbox.checkSourceAccountWarnings_('[X] Family');
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('[X] Family - Food'));
  assert.ok(warnings[0].includes('2024-01-15'));
});

test('checkSourceAccountWarnings_: does not warn for sibling account with shared name prefix', function() {
  const { sandbox } = loadCode();
  withTxnSheet_(sandbox, [
    { transaction_date: '2024-01-15', source_account_name: '[X] FamilyFlex' },
  ]);

  const warnings = sandbox.checkSourceAccountWarnings_('[X] Family');
  assert.equal(warnings.length, 0);
});

test('checkSourceAccountWarnings_: no warnings when source is a non-expense account', function() {
  const { sandbox } = loadCode();
  withTxnSheet_(sandbox, [
    { transaction_date: '2023-03-10', source_account_name: '[A] Bank - Checking' },
    { transaction_date: '2023-04-10', source_account_name: '[X] Other - Category' },
  ]);

  const warnings = sandbox.checkSourceAccountWarnings_('[X] Family');
  assert.equal(warnings.length, 0);
});

test('checkSourceAccountWarnings_: groups multiple dates under one account entry', function() {
  const { sandbox } = loadCode();
  withTxnSheet_(sandbox, [
    { transaction_date: '2023-01-10', source_account_name: '[X] Family - Food' },
    { transaction_date: '2023-06-15', source_account_name: '[X] Family - Food' },
  ]);

  const warnings = sandbox.checkSourceAccountWarnings_('[X] Family');
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('2023-01-10'));
  assert.ok(warnings[0].includes('2023-06-15'));
});

test('checkSourceAccountWarnings_: returns empty array when Transactions sheet is empty', function() {
  const { sandbox } = loadCode();
  sandbox.SpreadsheetApp.getActiveSpreadsheet = function() {
    return {
      getSheetByName(name) {
        if (name !== 'Transactions') return null;
        return { getLastRow() { return 1; } };
      },
      getSpreadsheetTimeZone() { return 'UTC'; },
    };
  };

  const warnings = sandbox.checkSourceAccountWarnings_('[X] Family');
  assert.equal(warnings.length, 0);
});

test('isReportAccount_: returns true for Expenses and Income markers', function() {
  const { sandbox } = loadCode();
  assert.ok(sandbox.isReportAccount_('[X] Family - Food'));
  assert.ok(sandbox.isReportAccount_('[I] Salary'));
});

test('isReportAccount_: returns false for Assets, Liabilities, Equity', function() {
  const { sandbox } = loadCode();
  assert.ok(!sandbox.isReportAccount_('[A] Bank - Checking'));
  assert.ok(!sandbox.isReportAccount_('[L] CreditCard'));
  assert.ok(!sandbox.isReportAccount_('[E] Opening'));
});

test('matchesAccountPrefix_: exact match and subtree match', function() {
  const { sandbox } = loadCode();
  assert.ok(sandbox.matchesAccountPrefix_('[X] Family', '[X] Family'));
  assert.ok(sandbox.matchesAccountPrefix_('[X] Family - Food', '[X] Family'));
  assert.ok(!sandbox.matchesAccountPrefix_('[X] FamilyFlex', '[X] Family'));
  assert.ok(!sandbox.matchesAccountPrefix_('[X] Other', '[X] Family'));
});

test('findUniqueReportSheetName_: returns baseName when sheet does not exist', function() {
  const { sandbox } = loadCode();
  const ss = { getSheetByName(_name) { return null; } };
  assert.equal(sandbox.findUniqueReportSheetName_(ss, 'Report (Food)'), 'Report (Food)');
});

test('findUniqueReportSheetName_: appends (2) when baseName already exists', function() {
  const { sandbox } = loadCode();
  const existing = new Set(['Report (Food)']);
  const ss = { getSheetByName(name) { return existing.has(name) ? {} : null; } };
  assert.equal(sandbox.findUniqueReportSheetName_(ss, 'Report (Food)'), 'Report (Food) (2)');
});

test('findUniqueReportSheetName_: increments until finding a free name', function() {
  const { sandbox } = loadCode();
  const existing = new Set(['Report (Food)', 'Report (Food) (2)', 'Report (Food) (3)']);
  const ss = { getSheetByName(name) { return existing.has(name) ? {} : null; } };
  assert.equal(sandbox.findUniqueReportSheetName_(ss, 'Report (Food)'), 'Report (Food) (4)');
});

test('scanSourceWarnings_: accepts an array of prefixes and matches any', function() {
  const { sandbox } = loadCode();
  const rows = [
    { transaction_date: '2024-01-10', source_account_name: '[X] Family - Food' },
    { transaction_date: '2024-02-01', source_account_name: '[I] Salary - Bonus' },
    { transaction_date: '2024-03-01', source_account_name: '[A] Bank' },
  ];
  const warnings = sandbox.scanSourceWarnings_(rows, ['[X] Family', '[I] Salary']);
  assert.equal(warnings.length, 2);
  assert.ok(warnings.some(function(w) { return w.includes('[X] Family - Food'); }));
  assert.ok(warnings.some(function(w) { return w.includes('[I] Salary - Bonus'); }));
});

test('scanSourceWarnings_: accepts a single string as a prefix (backwards compat)', function() {
  const { sandbox } = loadCode();
  const rows = [{ transaction_date: '2024-01-10', source_account_name: '[X] Family - Food' }];
  const warnings = sandbox.scanSourceWarnings_(rows, '[X] Family');
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('[X] Family - Food'));
});

test('buildDestLevelFormula_ produces a SPLIT formula referencing destination_account_name column', function() {
  const { sandbox } = loadCode();
  const txnConfig = sandbox.getSheetConfigByName_('Transactions');
  const formula = sandbox.buildDestLevelFormula_(2, txnConfig);

  assert.ok(formula.startsWith('='), 'formula must start with =');
  assert.ok(formula.includes('SPLIT'), 'must use SPLIT');
  assert.ok(formula.includes('MID'), 'must use MID to strip marker');
  assert.ok(formula.includes('FIND'), 'must use FIND to locate the space after the marker');
  assert.ok(formula.includes('" - "'), 'must split on " - "');
  // destination_account_name is column H (1-based column 8)
  assert.ok(formula.includes('$H2'), 'must reference destination_account_name column H at row 2');
});
