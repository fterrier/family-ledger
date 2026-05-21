const test = require('node:test');
const assert = require('node:assert/strict');

const { loadCode } = require('./_harness');

test('syncLedger fetches accounts and transactions once without resetting layouts', () => {
  const calls = [];
  const toasts = [];
  const sheets = {
    Accounts: { name: 'Accounts', setFrozenRows() {}, getRange() { return { setFormulas() {} }; } },
    Balances: { name: 'Balances', setFrozenRows() {} },
    Commodities: { name: 'Commodities', setFrozenRows() {} },
    Transactions: { name: 'Transactions', setFrozenRows() {}, getLastRow() { return 3; }, getRange() { return { setFormulas() {} }; } },
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
    if (resourceKey === 'commodities') return [{ symbol: 'CHF' }];
    if (resourceKey === 'accounts') {
      return [{ name: 'accounts/checking', account_name: 'Assets:Bank:Checking' }];
    }
    if (resourceKey === 'balance_assertions') return [];
    return [{ name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: '', narration: '', postings: [] }];
  };
  sandbox.buildAccountSyncData_ = function(accounts) {
    calls.push({ type: 'buildAccountSyncData', count: accounts.length });
    return {
      accountRows: [['accounts/checking', '[A] Bank - Checking', '']],
      accountResourceToDisplayName: { 'accounts/checking': '[A] Bank - Checking' },
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
  sandbox.fetchLedgerDoctorIssuesByTarget_ = function() {
    calls.push('fetchLedgerDoctorIssuesByTarget');
    return {};
  };
  sandbox.writeFetchedDoctorIssueSheets_ = function() {
    calls.push('writeFetchedDoctorIssueSheets');
  };
  sandbox.writeSheet_ = function(sheet, _headers, rows) {
    calls.push({ type: 'writeSheet', sheet: sheet.name, rowCount: rows.length });
  };
  sandbox.ensureSheetCapacity_ = function() {};
  sandbox.refreshManagedLedgerSheetLayouts_ = function() {
    calls.push('refreshManagedLedgerSheetLayouts');
  };

  sandbox.syncLedger();

  assert.deepEqual(JSON.parse(JSON.stringify(calls.filter((call) => call.type === 'fetch'))), [
    { type: 'fetch', path: '/commodities?page_size=1000', resourceKey: 'commodities' },
    { type: 'fetch', path: '/accounts?page_size=1000', resourceKey: 'accounts' },
    { type: 'fetch', path: '/transactions?page_size=1000', resourceKey: 'transactions' },
    { type: 'fetch', path: '/balance-assertions?page_size=1000', resourceKey: 'balance_assertions' },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.filter((call) => call.type === 'writeSheet'))), [
    { type: 'writeSheet', sheet: 'Commodities', rowCount: 1 },
    { type: 'writeSheet', sheet: 'Accounts', rowCount: 1 },
    { type: 'writeSheet', sheet: 'Balances', rowCount: 0 },
    { type: 'writeSheet', sheet: 'Transactions', rowCount: 1 },
  ]);
  assert.equal(calls.filter((call) => call.type === 'deleteSheet').length, 0, 'sheets must not be deleted during sync');
  assert.equal(calls.filter((call) => call === 'fetchLedgerDoctorIssuesByTarget').length, 1);
  assert.equal(calls.filter((call) => call === 'writeFetchedDoctorIssueSheets').length, 1);
  assert.equal(calls.filter((call) => call === 'refreshManagedLedgerSheetLayouts').length, 0);
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].title, 'Ledger Sync Complete');
  assert.match(toasts[0].message, /Synced 1 accounts/);
  assert.match(toasts[0].message, /Fetched 1 transactions and synced 1 allocation rows/);
});

test('buildTransactionSyncData_ collects skipped examples and leaves issues empty for VLOOKUP', () => {
  const { sandbox } = loadCode();
  sandbox.flattenTransactionForSheet_ = function(transaction) {
    if (transaction.name === 'transactions/skip') {
      return null;
    }
    return [{ resource_name: transaction.name, issues: '' }];
  };

  const result = sandbox.buildTransactionSyncData_([
    { name: 'transactions/ok', transaction_date: '2026-04-19', payee: '', narration: '', postings: [] },
    { name: 'transactions/skip', transaction_date: '2019-02-15', payee: null, narration: 'Transfer Helvetia', postings: [{}, {}, {}] },
  ], {});

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].issues, '');
  assert.equal(result.skippedCount, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(result.skippedExamples)), ['2019-02-15 |  | Transfer Helvetia | postings=3']);
});
