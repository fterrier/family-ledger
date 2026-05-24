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
    Attachments: { name: 'Attachments', setFrozenRows() {}, getRange() { return { setFormulas() {} }; } },
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
    if (resourceKey === 'attachments') return [];
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
    { type: 'fetch', path: '/attachments?page_size=1000', resourceKey: 'attachments' },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.filter((call) => call.type === 'writeSheet'))), [
    { type: 'writeSheet', sheet: 'Commodities', rowCount: 1 },
    { type: 'writeSheet', sheet: 'Accounts', rowCount: 1 },
    { type: 'writeSheet', sheet: 'Balances', rowCount: 0 },
    { type: 'writeSheet', sheet: 'Attachments', rowCount: 0 },
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

test('buildLedgerSyncSummaryMessage_ formats counts with no skipped', () => {
  const { sandbox } = loadCode();

  const msg = sandbox.buildLedgerSyncSummaryMessage_(
    3, 50, { rows: new Array(48), skippedCount: 0, skippedExamples: [] }, 10, 2, 5
  );

  assert.ok(msg.includes('Synced 3 accounts, 2 commodities.'), 'accounts and commodities');
  assert.ok(msg.includes('Fetched 50 transactions and synced 48 allocation rows.'), 'transactions');
  assert.ok(msg.includes('Synced 10 balance assertions.'), 'balance assertions');
  assert.ok(msg.includes('Synced 5 attachments.'), 'attachments');
  assert.ok(!msg.includes('Skipped'), 'no skipped line when count is 0');
});

test('buildLedgerSyncSummaryMessage_ appends skipped block when count > 0', () => {
  const { sandbox } = loadCode();

  const msg = sandbox.buildLedgerSyncSummaryMessage_(
    1, 5, { rows: new Array(4), skippedCount: 2, skippedExamples: ['2026-01-01 | | FX | postings=3'] }, 0, 1, 0
  );

  assert.ok(msg.includes('Skipped 2 unsupported transactions.'), 'skipped count');
  assert.ok(msg.includes('2026-01-01 | | FX | postings=3'), 'skipped example');
});

test('buildAccountSyncData_ converts accounts to sorted rows with display names', () => {
  const { sandbox } = loadCode();

  const accounts = [
    { name: 'accounts/food', account_name: 'Expenses:Food', effective_start_date: '2020-01-01' },
    { name: 'accounts/checking', account_name: 'Assets:Bank:Checking', effective_start_date: '2019-01-01' },
  ];

  const result = sandbox.buildAccountSyncData_(accounts);

  assert.equal(result.accountCount, 2);
  assert.ok(Array.isArray(result.accountRows));
  assert.equal(result.accountRows.length, 2);

  assert.ok(result.accountRows[0].account_name.startsWith('[A]'), 'Assets account sorted first');
  assert.ok(result.accountRows[1].account_name.startsWith('[X]'), 'Expenses account sorted second');

  assert.ok(typeof result.accountResourceToDisplayName === 'object');
  assert.ok(result.accountResourceToDisplayName['accounts/checking'].startsWith('[A]'));
  assert.ok(result.accountResourceToDisplayName['accounts/food'].startsWith('[X]'));
});

test('buildBalanceAssertionSyncRows_ maps assertions to sheet rows resolving account display name', () => {
  const { sandbox } = loadCode();

  const accountLookup = { 'accounts/checking': '[A] Bank - Checking' };
  const assertions = [
    {
      name: 'balanceAssertions/ba_1',
      assertion_date: '2026-04-30',
      account: 'accounts/checking',
      amount: { amount: '1500.00', symbol: 'CHF' },
    },
    {
      name: 'balanceAssertions/ba_2',
      assertion_date: '2026-05-31',
      account: 'accounts/unknown',
      amount: { amount: '200.00', symbol: 'USD' },
    },
  ];

  const rows = sandbox.buildBalanceAssertionSyncRows_(assertions, accountLookup);

  assert.equal(rows.length, 2);
  assert.equal(rows[0].resource_name, 'balanceAssertions/ba_1');
  assert.equal(rows[0].assertion_date, '2026-04-30');
  assert.equal(rows[0].account, '[A] Bank - Checking');
  assert.equal(rows[0].amount, '1500.00');
  assert.equal(rows[0].symbol, 'CHF');
  assert.equal(rows[0].issues, '');

  assert.equal(rows[1].account, 'accounts/unknown');
});

test('buildAttachmentSyncRows_ maps attachments to sheet rows with hyperlink cell for document_url', () => {
  const { sandbox } = loadCode();

  const accountLookup = { 'accounts/checking': '[A] Bank - Checking' };
  const attachments = [
    {
      name: 'attachments/att_1',
      attachment_date: '2026-05-01',
      account: 'accounts/checking',
      original_filename: 'statement.pdf',
      document_url: 'https://paperless.example.com/api/documents/42/',
      status: 'stored',
    },
    {
      name: 'attachments/att_2',
      attachment_date: '2026-05-15',
      account: 'accounts/other',
      original_filename: 'receipt.pdf',
      document_url: null,
      status: 'pending_upload',
    },
  ];

  const rows = sandbox.buildAttachmentSyncRows_(attachments, accountLookup);

  assert.equal(rows.length, 2);
  assert.equal(rows[0].resource_name, 'attachments/att_1');
  assert.equal(rows[0].attachment_date, '2026-05-01');
  assert.equal(rows[0].account, '[A] Bank - Checking');
  assert.equal(rows[0].status, 'stored');
  assert.equal(rows[0].issues, '');
  assert.ok(rows[0].original_filename.includes('HYPERLINK'), 'stored attachment uses HYPERLINK formula');
  assert.equal(rows[1].original_filename, 'receipt.pdf');
});
