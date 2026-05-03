const test = require('node:test');
const assert = require('node:assert/strict');

const { loadCode } = require('./_harness');

test('syncLedger fetches accounts and transactions once without resetting layouts', () => {
  const calls = [];
  const toasts = [];
  const sheets = {
    Accounts: { name: 'Accounts', setFrozenRows() {} },
    Transactions: { name: 'Transactions', setFrozenRows() {}, getLastRow() { return 3; } },
    DoctorTransactionIssues: { name: 'DoctorTransactionIssues' },
    DoctorAccountIssues: { name: 'DoctorAccountIssues' },
  };
  const { sandbox } = loadCode({
    SpreadsheetApp: {
      getActiveSpreadsheet() {
        return {
          getId() { return 'spreadsheet-id'; },
          getSheetByName(name) { return sheets[name] || null; },
          insertSheet(name) { calls.push({ type: 'insertSheet', name }); return sheets[name]; },
          deleteSheet() { calls.push({ type: 'deleteSheet' }); },
          toast(message, title) { toasts.push({ title, message }); },
        };
      },
    },
  });

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

  sandbox.syncLedger();

  assert.deepEqual(JSON.parse(JSON.stringify(calls.filter((call) => call.type === 'fetch'))), [
    { type: 'fetch', path: '/accounts?page_size=1000', resourceKey: 'accounts' },
    { type: 'fetch', path: '/transactions?page_size=1000', resourceKey: 'transactions' },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.filter((call) => call.type === 'writeSheet'))), [
    { type: 'writeSheet', sheet: 'Accounts', rowCount: 1 },
  ]);
  assert.equal(calls.filter((call) => call.type === 'deleteSheet').length, 0, 'sheets must not be deleted during sync');
  assert.equal(calls.filter((call) => call === 'fetchLedgerDoctorIssuesByTarget').length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.filter((call) => call.type === 'writeFetchedDoctorIssueSheets'))), [
    { type: 'writeFetchedDoctorIssueSheets', issueTargetCount: 0 },
  ]);
  assert.equal(calls.filter((call) => call === 'refreshManagedLedgerSheetLayouts').length, 0);
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].title, 'Ledger Sync Complete');
  assert.match(toasts[0].message, /Synced 1 accounts/);
  assert.match(toasts[0].message, /Fetched 1 transactions and synced 1 allocation rows/);
});

test('syncLedgerAndResetLayout runs sync then layout reset', () => {
  const calls = [];
  const { sandbox } = loadCode();
  sandbox.syncLedger = function() {
    calls.push('syncLedger');
  };
  sandbox.refreshManagedLedgerSheetLayouts_ = function() {
    calls.push('refreshManagedLedgerSheetLayouts');
  };

  sandbox.syncLedgerAndResetLayout();

  assert.deepEqual(calls, ['syncLedger', 'refreshManagedLedgerSheetLayouts']);
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
