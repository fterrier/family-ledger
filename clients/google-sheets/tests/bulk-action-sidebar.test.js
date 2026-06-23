const test = require('node:test');
const assert = require('node:assert/strict');

const { loadCode, makeRowStoreSheet_ } = require('./_harness');

// --- readSidebarSession_ ---

test('readSidebarSession_ returns null when property absent', () => {
  const { sandbox } = loadCode();
  assert.equal(sandbox.readSidebarSession_(), null);
});

test('readSidebarSession_ returns null when session is expired (> 15 min)', () => {
  const { sandbox, documentProperties } = loadCode();
  const expired = {
    classKey: 'transactions',
    selectedEntities: [],
    sessionTimestamp: Date.now() - 16 * 60 * 1000,
  };
  documentProperties.set('family_ledger_sidebar_session', JSON.stringify(expired));
  assert.equal(sandbox.readSidebarSession_(), null);
  assert.ok(!documentProperties.has('family_ledger_sidebar_session'), 'property should be deleted on expiry');
});

test('readSidebarSession_ returns session when valid', () => {
  const { sandbox, documentProperties } = loadCode();
  const session = {
    classKey: 'transactions',
    selectedEntities: [{ name: 'transactions/txn_1', span: { start: 2, count: 1 }, summary: 'Migros | 2026-01-01 | 84.25 CHF' }],
    sessionTimestamp: Date.now(),
  };
  documentProperties.set('family_ledger_sidebar_session', JSON.stringify(session));
  const result = sandbox.readSidebarSession_();
  assert.equal(result.classKey, 'transactions');
  assert.equal(result.selectedEntities.length, 1);
  assert.equal(result.selectedEntities[0].name, 'transactions/txn_1');
});

// --- createSidebarSession_ ---

test('createSidebarSession_ writes a session with 1 entity and returns it', () => {
  const { sandbox, documentProperties } = loadCode();
  const entity = { name: 'transactions/txn_1', span: { start: 2, count: 1 }, summary: 'Migros | 2026-01-01 | 84.25 CHF' };
  const result = sandbox.createSidebarSession_('transactions', entity);
  assert.equal(result.classKey, 'transactions');
  assert.equal(result.selectedEntities.length, 1);
  assert.equal(result.selectedEntities[0].name, 'transactions/txn_1');
  const stored = JSON.parse(documentProperties.get('family_ledger_sidebar_session'));
  assert.equal(stored.classKey, 'transactions');
  assert.equal(stored.selectedEntities[0].name, 'transactions/txn_1');
  assert.ok(typeof stored.sessionTimestamp === 'number');
});

// --- addToSidebarSession_ ---

test('addToSidebarSession_ appends a second entity and persists', () => {
  const { sandbox, documentProperties } = loadCode();
  const session = {
    classKey: 'transactions',
    selectedEntities: [{ name: 'transactions/txn_1', span: { start: 2, count: 1 }, summary: 'A' }],
    sessionTimestamp: Date.now(),
  };
  const entity2 = { name: 'transactions/txn_2', span: { start: 4, count: 1 }, summary: 'B' };
  const result = sandbox.addToSidebarSession_(session, entity2);
  assert.equal(result.selectedEntities.length, 2);
  assert.equal(result.selectedEntities[1].name, 'transactions/txn_2');
  const stored = JSON.parse(documentProperties.get('family_ledger_sidebar_session'));
  assert.equal(stored.selectedEntities.length, 2);
});

test('addToSidebarSession_ deduplicates by name (no-op if already present)', () => {
  const { sandbox } = loadCode();
  const entity = { name: 'transactions/txn_1', span: { start: 2, count: 1 }, summary: 'A' };
  const session = {
    classKey: 'transactions',
    selectedEntities: [entity],
    sessionTimestamp: Date.now(),
  };
  const result = sandbox.addToSidebarSession_(session, entity);
  assert.equal(result.selectedEntities.length, 1);
});

test('addToSidebarSession_ refreshes the session timestamp', () => {
  const { sandbox } = loadCode();
  const oldTimestamp = Date.now() - 5000;
  const session = {
    classKey: 'transactions',
    selectedEntities: [{ name: 'transactions/txn_1', span: { start: 2, count: 1 }, summary: 'A' }],
    sessionTimestamp: oldTimestamp,
  };
  const entity2 = { name: 'transactions/txn_2', span: { start: 4, count: 1 }, summary: 'B' };
  const result = sandbox.addToSidebarSession_(session, entity2);
  assert.ok(result.sessionTimestamp > oldTimestamp, 'timestamp should be refreshed');
});

// --- clearSidebarSession_ ---

test('clearSidebarSession_ removes the document property', () => {
  const { sandbox, documentProperties } = loadCode();
  documentProperties.set('family_ledger_sidebar_session', JSON.stringify({ classKey: 'transactions' }));
  sandbox.clearSidebarSession_();
  assert.ok(!documentProperties.has('family_ledger_sidebar_session'));
});

// --- removeFromSidebarSession_ ---

test('removeFromSidebarSession_ removes entity by name and returns updated session', () => {
  const { sandbox } = loadCode();
  const session = {
    classKey: 'transactions',
    selectedEntities: [
      { name: 'transactions/txn_1', span: { start: 2, count: 1 }, summary: 'A' },
      { name: 'transactions/txn_2', span: { start: 3, count: 1 }, summary: 'B' },
    ],
    sessionTimestamp: Date.now(),
  };
  const updated = sandbox.removeFromSidebarSession_(session, 'transactions/txn_1');
  assert.equal(updated.selectedEntities.length, 1);
  assert.equal(updated.selectedEntities[0].name, 'transactions/txn_2');
});

test('removeFromSidebarSession_ is a no-op when name not present', () => {
  const { sandbox, documentProperties } = loadCode();
  const session = {
    classKey: 'transactions',
    selectedEntities: [{ name: 'transactions/txn_1', span: { start: 2, count: 1 }, summary: 'A' }],
    sessionTimestamp: Date.now(),
  };
  documentProperties.set('family_ledger_sidebar_session', JSON.stringify(session));
  const updated = sandbox.removeFromSidebarSession_(session, 'transactions/txn_999');
  assert.equal(updated.selectedEntities.length, 1);
});

test('removeFromSidebarSession_ refreshes the session timestamp', () => {
  const { sandbox } = loadCode();
  const oldTimestamp = Date.now() - 5000;
  const session = {
    classKey: 'transactions',
    selectedEntities: [
      { name: 'transactions/txn_1', span: { start: 2, count: 1 }, summary: 'A' },
      { name: 'transactions/txn_2', span: { start: 3, count: 1 }, summary: 'B' },
    ],
    sessionTimestamp: oldTimestamp,
  };
  const updated = sandbox.removeFromSidebarSession_(session, 'transactions/txn_1');
  assert.ok(updated.sessionTimestamp > oldTimestamp, 'timestamp should be refreshed');
});

// --- removeFromMultiSelect ---

test('removeFromMultiSelect with 3→2 entities keeps session and re-shows multi-select', () => {
  const multiSelectCalls = [];
  const { sandbox, documentProperties } = loadCode();
  sandbox.showMultiSelectSidebar_ = function(classKey, entities) {
    multiSelectCalls.push({ classKey, entities });
  };
  const session = {
    classKey: 'transactions',
    selectedEntities: [
      { name: 'transactions/txn_1', span: { start: 2, count: 1 }, summary: 'A' },
      { name: 'transactions/txn_2', span: { start: 3, count: 1 }, summary: 'B' },
      { name: 'transactions/txn_3', span: { start: 4, count: 1 }, summary: 'C' },
    ],
    sessionTimestamp: Date.now(),
  };
  documentProperties.set('family_ledger_sidebar_session', JSON.stringify(session));
  sandbox.removeFromMultiSelect('transactions/txn_1');
  const stored = JSON.parse(documentProperties.get('family_ledger_sidebar_session'));
  assert.equal(stored.selectedEntities.length, 2);
  assert.ok(stored.selectedEntities.every(e => e.name !== 'transactions/txn_1'));
  assert.equal(multiSelectCalls.length, 1, 'multi-select sidebar refreshed');
});

test('removeFromMultiSelect with 2→1 entities clears session and opens edit sidebar', () => {
  const editSidebarCalls = [];
  const { sandbox, documentProperties } = loadCode({
    SpreadsheetApp: {
      getActiveSpreadsheet() { return { toast() {} }; },
      getUi() { return { showSidebar() {} }; },
    },
  });
  sandbox.showEditSidebar_ = function(classKey, name, span) {
    editSidebarCalls.push({ classKey, name, span });
  };
  const session = {
    classKey: 'transactions',
    selectedEntities: [
      { name: 'transactions/txn_1', span: { start: 2, count: 1 }, summary: 'A' },
      { name: 'transactions/txn_2', span: { start: 3, count: 1 }, summary: 'B' },
    ],
    sessionTimestamp: Date.now(),
  };
  documentProperties.set('family_ledger_sidebar_session', JSON.stringify(session));
  sandbox.removeFromMultiSelect('transactions/txn_1');
  assert.ok(!documentProperties.has('family_ledger_sidebar_session'), 'session cleared');
  assert.equal(editSidebarCalls.length, 1, 'edit sidebar opened');
  assert.equal(editSidebarCalls[0].name, 'transactions/txn_2', 'opens remaining entity');
});

test('removeFromMultiSelect with 1→0 entities clears session', () => {
  const { sandbox, documentProperties } = loadCode();
  const session = {
    classKey: 'transactions',
    selectedEntities: [{ name: 'transactions/txn_1', span: { start: 2, count: 1 }, summary: 'A' }],
    sessionTimestamp: Date.now(),
  };
  documentProperties.set('family_ledger_sidebar_session', JSON.stringify(session));
  sandbox.removeFromMultiSelect('transactions/txn_1');
  assert.ok(!documentProperties.has('family_ledger_sidebar_session'), 'session cleared');
});

test('removeFromMultiSelect with no active session is a no-op', () => {
  const { sandbox, documentProperties } = loadCode();
  sandbox.removeFromMultiSelect('transactions/txn_1');
  assert.ok(!documentProperties.has('family_ledger_sidebar_session'));
});

// --- cancelMultiSelect / cancelSidebar ---

test('cancelMultiSelect clears the sidebar session', () => {
  const { sandbox, documentProperties } = loadCode();
  documentProperties.set('family_ledger_sidebar_session', JSON.stringify({ classKey: 'transactions' }));
  sandbox.cancelMultiSelect();
  assert.ok(!documentProperties.has('family_ledger_sidebar_session'));
});

test('cancelSidebar clears the sidebar session', () => {
  const { sandbox, documentProperties } = loadCode();
  documentProperties.set('family_ledger_sidebar_session', JSON.stringify({ classKey: 'transactions' }));
  sandbox.cancelSidebar();
  assert.ok(!documentProperties.has('family_ledger_sidebar_session'));
});

// --- deleteMultipleEntities ---

test('deleteMultipleEntities deletes bottom-up and removes all selected rows', () => {
  const rowStore = new Map([
    [2, { resource_name: 'transactions/txn_1', transaction_date: '2026-01-01', payee: 'A', narration: '', source_account_name: 'Cash', destination_account_name: 'Food', symbol: 'CHF', amount: 10, split_off_amount: '', issues: '', narration_source: 'txn', edit: '' }],
    [3, { resource_name: 'transactions/txn_2', transaction_date: '2026-01-02', payee: 'B', narration: '', source_account_name: 'Cash', destination_account_name: 'Food', symbol: 'CHF', amount: 20, split_off_amount: '', issues: '', narration_source: 'txn', edit: '' }],
    [4, { resource_name: 'transactions/txn_other', transaction_date: '2026-01-03', payee: 'C', narration: '', source_account_name: 'Cash', destination_account_name: 'Food', symbol: 'CHF', amount: 30, split_off_amount: '', issues: '', narration_source: 'txn', edit: '' }],
  ]);

  const apiCalls = [];
  const { sandbox } = loadCode({
    SpreadsheetApp: {
      getActiveSpreadsheet() { return { toast() {}, getSheetByName() { return null; }, getSpreadsheetTimeZone() { return 'UTC'; } }; },
    },
  });
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, []);
  sandbox.apiFetchJson_ = function(method, path) { apiCalls.push({ method, path }); return {}; };
  sandbox.getOrCreateSheet_ = function() { return fakeSheet; };
  sandbox.loadAccountOptions_ = function() { return []; };
  sandbox.refreshDoctorIssueSheets_ = function() {};

  sandbox.deleteMultipleEntities('transactions', [
    { name: 'transactions/txn_1', span: { start: 2, count: 1 } },
    { name: 'transactions/txn_2', span: { start: 3, count: 1 } },
  ]);

  assert.ok(apiCalls.some(c => c.method === 'delete' && c.path === '/transactions/txn_1'), 'DELETE txn_1');
  assert.ok(apiCalls.some(c => c.method === 'delete' && c.path === '/transactions/txn_2'), 'DELETE txn_2');
  assert.equal(rowStore.get(2).resource_name, 'transactions/txn_other', 'txn_other shifts to row 2');
  assert.ok(rowStore.size === 1, 'only 1 row remains');
});

test('deleteMultipleEntities clears the sidebar session after completion', () => {
  const rowStore = new Map([
    [2, { resource_name: 'transactions/txn_1', transaction_date: '2026-01-01', payee: 'A', narration: '', source_account_name: 'Cash', destination_account_name: 'Food', symbol: 'CHF', amount: 10, split_off_amount: '', issues: '', narration_source: 'txn', edit: '' }],
  ]);

  const { sandbox, documentProperties } = loadCode({
    SpreadsheetApp: {
      getActiveSpreadsheet() { return { toast() {}, getSheetByName() { return null; }, getSpreadsheetTimeZone() { return 'UTC'; } }; },
    },
  });
  documentProperties.set('family_ledger_sidebar_session', JSON.stringify({ classKey: 'transactions', selectedEntities: [] }));
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, []);
  sandbox.apiFetchJson_ = function() { return {}; };
  sandbox.getOrCreateSheet_ = function() { return fakeSheet; };
  sandbox.loadAccountOptions_ = function() { return []; };
  sandbox.refreshDoctorIssueSheets_ = function() {};

  sandbox.deleteMultipleEntities('transactions', [
    { name: 'transactions/txn_1', span: { start: 2, count: 1 } },
  ]);

  assert.ok(!documentProperties.has('family_ledger_sidebar_session'), 'session cleared after deletion');
});

test('deleteMultipleEntities handles multi-row entities (span.count > 1)', () => {
  const rowStore = new Map([
    [2, { resource_name: 'transactions/txn_split', transaction_date: '2026-01-01', payee: 'Split', narration: '', source_account_name: 'Cash', destination_account_name: 'Food', symbol: 'CHF', amount: 60, split_off_amount: '', issues: '', narration_source: 'txn', edit: '' }],
    [3, { resource_name: 'transactions/txn_split', transaction_date: '2026-01-01', payee: 'Split', narration: '', source_account_name: 'Cash', destination_account_name: 'Coffee', symbol: 'CHF', amount: 40, split_off_amount: '', issues: '', narration_source: 'txn', edit: '' }],
    [4, { resource_name: 'transactions/txn_other', transaction_date: '2026-01-02', payee: 'Other', narration: '', source_account_name: 'Cash', destination_account_name: 'Food', symbol: 'CHF', amount: 10, split_off_amount: '', issues: '', narration_source: 'txn', edit: '' }],
  ]);

  const { sandbox } = loadCode({
    SpreadsheetApp: {
      getActiveSpreadsheet() { return { toast() {}, getSheetByName() { return null; }, getSpreadsheetTimeZone() { return 'UTC'; } }; },
    },
  });
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, []);
  sandbox.apiFetchJson_ = function() { return {}; };
  sandbox.getOrCreateSheet_ = function() { return fakeSheet; };
  sandbox.loadAccountOptions_ = function() { return []; };
  sandbox.refreshDoctorIssueSheets_ = function() {};

  sandbox.deleteMultipleEntities('transactions', [
    { name: 'transactions/txn_split', span: { start: 2, count: 2 } },
  ]);

  assert.equal(rowStore.get(2).resource_name, 'transactions/txn_other', 'txn_other shifts to row 2');
  assert.ok(rowStore.size === 1);
});

// --- formatDisplayDate_ ---

test('formatDisplayDate_ converts yyyy-MM-dd string to readable format', () => {
  const { sandbox } = loadCode();
  assert.equal(sandbox.formatDisplayDate_('2026-04-19'), 'Apr 19, 2026');
  assert.equal(sandbox.formatDisplayDate_('2026-01-01'), 'Jan 1, 2026');
  assert.equal(sandbox.formatDisplayDate_('2026-12-31'), 'Dec 31, 2026');
});

test('formatDisplayDate_ returns empty string for empty/null input', () => {
  const { sandbox } = loadCode();
  assert.equal(sandbox.formatDisplayDate_(''), '');
  assert.equal(sandbox.formatDisplayDate_(null), '');
});

test('formatDisplayDate_ passes non-date strings through unchanged', () => {
  const { sandbox } = loadCode();
  assert.equal(sandbox.formatDisplayDate_('not a date'), 'not a date');
});

// --- buildMultiSelectSummary_ ---

test('Transaction.buildMultiSelectSummary_ returns summary with payee, date, amount and symbol', () => {
  const { sandbox } = loadCode();
  const rows = [{
    payee: 'Migros',
    transaction_date: '2026-01-01',
    amount: 84.25,
    symbol: 'CHF',
  }];
  const summary = sandbox.ENTITY_CLASS_REGISTRY['transactions'].buildMultiSelectSummary_(rows);
  assert.ok(summary.includes('Migros'), 'includes payee');
  assert.ok(summary.includes('Jan 1, 2026'), 'includes formatted date');
  assert.ok(summary.includes('84.25'), 'includes amount');
  assert.ok(summary.includes('CHF'), 'includes symbol');
});

test('Transaction.buildMultiSelectSummary_ formats large amount with comma separator', () => {
  const { sandbox } = loadCode();
  const rows = [{ payee: 'Rent', transaction_date: '2026-01-01', amount: 1500.5, symbol: 'CHF' }];
  const summary = sandbox.ENTITY_CLASS_REGISTRY['transactions'].buildMultiSelectSummary_(rows);
  assert.ok(summary.includes('1,500.50'), 'includes comma-formatted amount');
});

test('Transaction.buildMultiSelectSummary_ handles empty payee', () => {
  const { sandbox } = loadCode();
  const rows = [{ payee: '', transaction_date: '2026-01-01', amount: 10, symbol: 'EUR' }];
  const summary = sandbox.ENTITY_CLASS_REGISTRY['transactions'].buildMultiSelectSummary_(rows);
  assert.ok(typeof summary === 'string');
  assert.ok(summary.includes('Jan 1, 2026'));
});

test('Account.buildMultiSelectSummary_ returns account_name', () => {
  const { sandbox } = loadCode();
  const rows = [{ account_name: 'Assets:Family:ZKB:Checking' }];
  const summary = sandbox.ENTITY_CLASS_REGISTRY['accounts'].buildMultiSelectSummary_(rows);
  assert.ok(summary.includes('Assets:Family:ZKB:Checking'));
});

test('Balance.buildMultiSelectSummary_ returns date, account and amount', () => {
  const { sandbox } = loadCode();
  const rows = [{ assertion_date: '2026-01-01', account: 'Assets:Cash', amount: 1000, symbol: 'CHF' }];
  const summary = sandbox.ENTITY_CLASS_REGISTRY['balances'].buildMultiSelectSummary_(rows);
  assert.ok(summary.includes('Jan 1, 2026'));
  assert.ok(summary.includes('Assets:Cash'));
  assert.ok(summary.includes('1,000.00'), 'includes comma-formatted amount');
});

test('Commodity.buildMultiSelectSummary_ returns symbol', () => {
  const { sandbox } = loadCode();
  const rows = [{ symbol: 'BTC', ticker: 'BTCUSD' }];
  const summary = sandbox.ENTITY_CLASS_REGISTRY['commodities'].buildMultiSelectSummary_(rows);
  assert.ok(summary.includes('BTC'));
});

test('Price.buildMultiSelectSummary_ returns date and symbol pair', () => {
  const { sandbox } = loadCode();
  const rows = [{ price_date: '2026-01-01', base_symbol: 'BTC', quote_symbol: 'USD', quote_amount: 95000 }];
  const summary = sandbox.ENTITY_CLASS_REGISTRY['prices'].buildMultiSelectSummary_(rows);
  assert.ok(summary.includes('Jan 1, 2026'));
  assert.ok(summary.includes('BTC'));
  assert.ok(summary.includes('95,000.00'), 'includes comma-formatted quote amount');
});

test('Attachment.buildMultiSelectSummary_ returns date and filename', () => {
  const { sandbox } = loadCode();
  const rows = [{ attachment_date: '2026-01-01', original_filename: 'receipt.pdf' }];
  const summary = sandbox.ENTITY_CLASS_REGISTRY['attachments'].buildMultiSelectSummary_(rows);
  assert.ok(summary.includes('Jan 1, 2026'));
  assert.ok(summary.includes('receipt.pdf'));
});

// --- formatDisplayAmount_ ---

test('formatDisplayAmount_ formats integer with two decimals', () => {
  const { sandbox } = loadCode();
  assert.equal(sandbox.formatDisplayAmount_(1000), '1,000.00');
  assert.equal(sandbox.formatDisplayAmount_(0), '0.00');
  assert.equal(sandbox.formatDisplayAmount_(42), '42.00');
});

test('formatDisplayAmount_ formats decimal with two decimal places', () => {
  const { sandbox } = loadCode();
  assert.equal(sandbox.formatDisplayAmount_(84.25), '84.25');
  assert.equal(sandbox.formatDisplayAmount_(1500.5), '1,500.50');
  assert.equal(sandbox.formatDisplayAmount_(95000), '95,000.00');
});

test('formatDisplayAmount_ returns original string for non-numeric input', () => {
  const { sandbox } = loadCode();
  assert.equal(sandbox.formatDisplayAmount_('abc'), 'abc');
  assert.equal(sandbox.formatDisplayAmount_(''), '');
});
