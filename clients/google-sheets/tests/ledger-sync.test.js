const test = require('node:test');
const assert = require('node:assert/strict');

const { loadCode } = require('./_harness');

test('syncFamilyLedger fetches accounts and transactions once and refreshes both sheets together', () => {
  const calls = [];
  const alerts = [];
  const sheets = {
    Accounts: { name: 'Accounts', setFrozenRows() {} },
    Transactions: { name: 'Transactions', setFrozenRows() {}, getLastRow() { return 3; } },
    DoctorTransactionIssues: { name: 'DoctorTransactionIssues' },
    DoctorAccountIssues: { name: 'DoctorAccountIssues' },
  };
  const { sandbox } = loadCode({
    SpreadsheetApp: {
      getUi() {
        return {
          ButtonSet: { OK: 'OK' },
          alert(title, message) {
            alerts.push({ title, message });
          },
        };
      },
      getActiveSpreadsheet() {
        return {
          getId() { return 'spreadsheet-id'; },
          getSheetByName(name) { return sheets[name] || null; },
          insertSheet(name) { return sheets[name]; },
        };
      },
    },
  });

  sandbox.rebuildSheetByName_ = function(name) {
    calls.push({ type: 'rebuildSheet', name });
    return sheets[name];
  };
  sandbox.ensureEditTriggerInstalled_ = function() {
    calls.push('ensureEditTriggerInstalled');
  };
  sandbox.fetchFamilyLedgerPagedResource_ = function(path, resourceKey) {
    calls.push({ type: 'fetch', path, resourceKey });
    if (resourceKey === 'accounts') {
      return [{ name: 'accounts/checking', account_name: 'Assets:Bank:Checking' }];
    }
    return [{ name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: '', narration: '', postings: [] }];
  };
  sandbox.buildAccountSyncData_ = function(accounts) {
    calls.push({ type: 'buildAccountSyncData', count: accounts.length });
    return {
      accountRows: [['accounts/checking', '[A] Bank - Checking', '']],
      accountDisplayLookup: { 'accounts/checking': '[A] Bank - Checking' },
      accountCount: 1,
    };
  };
  sandbox.buildTransactionSyncData_ = function(transactions, lookup) {
    calls.push({ type: 'buildTransactionSyncData', count: transactions.length, lookup });
    return {
      rows: [{ resource_name: 'transactions/txn_1' }],
      skippedCount: 0,
      skippedExamples: [],
    };
  };
  sandbox.writeFetchedDoctorIssueSheets_ = function(issuesByTarget, resolveSheet) {
    calls.push({ type: 'writeFetchedDoctorIssueSheets', issueTargetCount: Object.keys(issuesByTarget).length });
    resolveSheet('DoctorTransactionIssues');
    resolveSheet('DoctorAccountIssues');
  };
  sandbox.fetchLedgerDoctorIssuesByTarget_ = function() {
    calls.push('fetchLedgerDoctorIssuesByTarget');
    return {};
  };
  sandbox.writeSheet_ = function(sheet, _headers, rows) {
    calls.push({ type: 'writeSheet', sheet: sheet.name, rowCount: rows.length });
  };
  sandbox.ensureAccountIssueFormulas_ = function(sheet, rowCount) {
    calls.push({ type: 'accountIssues', sheet: sheet.name, rowCount });
  };
  sandbox.setTransactionSheetRows_ = function(sheet, rows) {
    calls.push({ type: 'writeTransactions', sheet: sheet.name, rowCount: rows.length });
  };
  sandbox.refreshManagedLedgerSheetLayouts_ = function() {
    calls.push('refreshManagedLedgerSheetLayouts');
  };

  sandbox.syncFamilyLedger();

  assert.deepEqual(JSON.parse(JSON.stringify(calls.filter((call) => call.type === 'fetch'))), [
    { type: 'fetch', path: '/accounts?page_size=1000', resourceKey: 'accounts' },
    { type: 'fetch', path: '/transactions?page_size=1000', resourceKey: 'transactions' },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.filter((call) => call.type === 'writeSheet'))), [
    { type: 'writeSheet', sheet: 'Accounts', rowCount: 1 },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.filter((call) => call.type === 'rebuildSheet'))), [
    { type: 'rebuildSheet', name: 'Accounts' },
    { type: 'rebuildSheet', name: 'Transactions' },
    { type: 'rebuildSheet', name: 'DoctorTransactionIssues' },
    { type: 'rebuildSheet', name: 'DoctorAccountIssues' },
  ]);
  assert.equal(calls.filter((call) => call === 'fetchLedgerDoctorIssuesByTarget').length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.filter((call) => call.type === 'writeFetchedDoctorIssueSheets'))), [
    { type: 'writeFetchedDoctorIssueSheets', issueTargetCount: 0 },
  ]);
  assert.equal(calls.filter((call) => call === 'refreshManagedLedgerSheetLayouts').length, 1);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].title, 'Ledger Sync Complete');
  assert.match(alerts[0].message, /Synced 1 accounts/);
  assert.match(alerts[0].message, /Fetched 1 transactions and synced 1 allocation rows/);
});

test('buildTransactionSyncData_ collects skipped examples and merges doctor issues', () => {
  const { sandbox } = loadCode();
  sandbox.flattenTransactionForSheet_ = function(transaction) {
    if (transaction.name === 'transactions/skip') {
      return null;
    }
    return [{ resource_name: transaction.name, issues: '' }];
  };
  sandbox.mergeFetchedDoctorIssuesIntoRows_ = function(rows) {
    rows.forEach(function(row) {
      row.issues = 'doctor';
    });
  };

  const result = sandbox.buildTransactionSyncData_([
    { name: 'transactions/ok', transaction_date: '2026-04-19', payee: '', narration: '', postings: [] },
    { name: 'transactions/skip', transaction_date: '2019-02-15', payee: null, narration: 'Transfer Helvetia', postings: [{}, {}, {}] },
  ], {});

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].issues, 'doctor');
  assert.equal(result.skippedCount, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(result.skippedExamples)), ['2019-02-15 |  | Transfer Helvetia | postings=3']);
});
