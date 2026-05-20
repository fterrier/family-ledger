const test = require('node:test');
const assert = require('node:assert/strict');

const { loadCode, makeRowStoreSheet_ } = require('./_harness');

test('ensureSheetFilter_ creates a filter covering all transaction columns', () => {
  const operations = [];
  const rowStore = new Map([[2, {
    resource_name: 'transactions/txn_1', transaction_date: new Date('2026-04-19T00:00:00.000Z'),
    payee: 'Migros', narration: 'Groceries', source_account_name: 'Assets:Bank:Checking',
    destination_account_name: 'Expenses:Food', amount: 84.25, split_off_amount: '',
    symbol: 'CHF', status: '', issues: '', last_error: '',
  }]]);
  const { sandbox } = loadCode();
  const sheet = makeRowStoreSheet_(sandbox, rowStore, operations);

  sandbox.ensureSheetFilter_(sheet, sandbox.getSheetConfigByName_('Transactions'));

  const filterOp = operations.find((op) => op.type === 'createFilter');
  assert.ok(filterOp, 'createFilter should have been called');
  assert.equal(filterOp.row, 1);
  assert.equal(filterOp.numRows, 2);
});

test('ensureSheetFilter_ restores existing filter criteria on the new filter', () => {
  const { sandbox } = loadCode();
  const criteriaByCol = { 3: { formula: '=C2>0' }, 6: { formula: '=F2="x"' } };
  const restored = [];
  const sheet = {
    getLastRow() { return 3; },
    getFilter() {
      return {
        getRange() {
          return { getNumColumns() { return 13; } };
        },
        getColumnFilterCriteria(col) { return criteriaByCol[col] || null; },
        remove() {},
      };
    },
    getRange(row, _column, _numRows, numCols) {
      return {
        getValues() {
          return [[
            'resource_name',
            'transaction_date',
            'payee',
            'narration',
            'narration_source',
            'source_account_name',
            'destination_account_name',
            'symbol',
            'amount',
            'split_off_amount',
            'status',
            'last_error',
            'issues',
          ].slice(0, numCols)];
        },
        createFilter() {
          return { setColumnFilterCriteria(col, criteria) { restored.push({ col, criteria }); } };
        },
      };
    },
  };

  sandbox.ensureSheetFilter_(sheet, sandbox.getSheetConfigByName_('Transactions'));

  assert.equal(restored.length, 2);
  assert.deepEqual(restored.map((r) => r.col).sort((a, b) => a - b), [3, 6]);
});

test('ensureSheetFilter_ tolerates a legacy narrower filter range', () => {
  const { sandbox } = loadCode();
  const restored = [];
  const accessedColumns = [];
  const sheet = {
    getLastRow() { return 3; },
    getFilter() {
      return {
        getRange() {
          return {
            getNumColumns() {
              return 6;
            },
          };
        },
        getColumnFilterCriteria(col) {
          accessedColumns.push(col);
          return col === 3 ? { formula: '=C2>0' } : null;
        },
        remove() {},
      };
    },
    getRange(_row, _column, _numRows, numCols) {
      return {
        getValues() {
          return [[
            'resource_name',
            'transaction_date',
            'payee',
            'narration',
            'narration_source',
            'source_account_name',
            'destination_account_name',
            'symbol',
            'amount',
            'split_off_amount',
            'status',
            'last_error',
            'issues',
          ].slice(0, numCols)];
        },
        createFilter() {
          return { setColumnFilterCriteria(col, criteria) { restored.push({ col, criteria }); } };
        },
      };
    },
  };

  sandbox.ensureSheetFilter_(sheet, sandbox.getSheetConfigByName_('Transactions'));

  assert.deepEqual(accessedColumns, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(restored, [{ col: 3, criteria: { formula: '=C2>0' } }]);
});

test('ensureSheetFilter_ restores hidden technical column criteria by header too', () => {
  const { sandbox } = loadCode();
  const restored = [];
  const sheet = {
    getLastRow() { return 3; },
    getFilter() {
      return {
        getRange() {
          return { getNumColumns() { return 13; } };
        },
        getColumnFilterCriteria(col) {
          return col === 6 ? { formula: '=$F2="txn"' } : null;
        },
        remove() {},
      };
    },
    getRange(_row, _column, _numRows, numCols) {
      return {
        getValues() {
          return [[
            'resource_name',
            'transaction_date',
            'payee',
            'narration',
            'narration_source',
            'source_account_name',
            'destination_account_name',
            'symbol',
            'amount',
            'split_off_amount',
            'status',
            'last_error',
            'issues',
          ].slice(0, numCols)];
        },
        createFilter() {
          return { setColumnFilterCriteria(col, criteria) { restored.push({ col, criteria }); } };
        },
      };
    },
  };

  sandbox.ensureSheetFilter_(sheet, sandbox.getSheetConfigByName_('Transactions'));

  assert.deepEqual(restored, [{ col: 6, criteria: { formula: '=$F2="txn"' } }]);
});

test('ensureSheetFilter_ does not call reapplyPersistedQuickFilters_ (caller responsibility)', () => {
  let reapplyCalled = false;
  const { sandbox } = loadCode();
  sandbox.reapplyPersistedQuickFilters_ = function() { reapplyCalled = true; };
  let activeFilter = {
    getRange() { return { getNumColumns() { return 13; } }; },
    getColumnFilterCriteria() { return null; },
    remove() {},
  };
  const sheet = {
    getLastRow() { return 3; },
    getFilter() { return activeFilter; },
    getRange(_row, _column, _numRows, _numCols) {
      return {
        getValues() { return [[]]; },
        createFilter() {
          activeFilter = { setColumnFilterCriteria() {}, removeColumnFilterCriteria() {} };
          return activeFilter;
        },
      };
    },
  };

  sandbox.ensureSheetFilter_(sheet, sandbox.getSheetConfigByName_('Transactions'));

  assert.equal(reapplyCalled, false);
});

test('ensureSheetFilter_ (accounts) snapshots and restores existing criteria uniformly', () => {
  const { sandbox } = loadCode();
  const criteriaByCol = { 2: { formula: '=B2<>""' } };
  const restored = [];
  const sheet = {
    getLastRow() { return 3; },
    getFilter() {
      return {
        getRange() { return { getNumColumns() { return 3; } }; },
        getColumnFilterCriteria(col) { return criteriaByCol[col] || null; },
        remove() {},
      };
    },
    getRange(_row, _column, _numRows, numCols) {
      return {
        getValues() { return [['resource_name', 'account_name', 'issues'].slice(0, numCols)]; },
        createFilter() {
          return { setColumnFilterCriteria(col, criteria) { restored.push({ col, criteria }); } };
        },
      };
    },
  };

  sandbox.ensureSheetFilter_(sheet, sandbox.getSheetConfigByName_('Accounts'));

  assert.deepEqual(restored, [{ col: 2, criteria: { formula: '=B2<>""' } }]);
});

test('getTransactionFilterYears returns unique years from transaction dates in descending order', () => {
  const dates = [
    new Date(Date.UTC(2024, 0, 15)),
    new Date(Date.UTC(2026, 2, 20)),
    new Date(Date.UTC(2024, 5, 10)),
    new Date(Date.UTC(2025, 11, 31)),
  ];
  const { sandbox } = loadCode({
    sheetsByName: {
      Transactions: {
        getLastRow() { return dates.length + 1; },
        getRange(_row, _col, numRows) {
          return {
            getValues() { return dates.slice(0, numRows).map((d) => [d]); },
          };
        },
      },
    },
  });

  assert.deepEqual(sandbox.getTransactionFilterYears(), [2026, 2025, 2024]);
});

test('applyTransactionQuickFilter sets range formula for full year', () => {
  const filterCriteria = [];
  const { sandbox } = loadCode({
    sheetsByName: {
      Transactions: {
        getLastRow() { return 5; },
        getFilter() {
          return { setColumnFilterCriteria(col, criteria) { filterCriteria.push({ col, criteria }); } };
        },
      },
    },
  });

  sandbox.applyQuickDateFilter('2026-01', '2026-12');

  assert.equal(filterCriteria[0].col, 3);
  assert.equal(filterCriteria[0].criteria.formula, '=AND(YEAR(C2)*100+MONTH(C2)>=202601,YEAR(C2)*100+MONTH(C2)<=202612)');
});

test('applyTransactionQuickFilter sets range formula for custom date range', () => {
  const filterCriteria = [];
  const { sandbox } = loadCode({
    sheetsByName: {
      Transactions: {
        getLastRow() { return 5; },
        getFilter() {
          return { setColumnFilterCriteria(col, criteria) { filterCriteria.push({ col, criteria }); } };
        },
      },
    },
  });

  sandbox.applyQuickDateFilter('2025-03', '2026-06');

  assert.equal(filterCriteria[0].criteria.formula, '=AND(YEAR(C2)*100+MONTH(C2)>=202503,YEAR(C2)*100+MONTH(C2)<=202606)');
});

test('clearTransactionQuickFilter removes filter criteria from date, source, and destination columns', () => {
  const removed = [];
  const { sandbox } = loadCode({
    sheetsByName: {
      Transactions: {
        getLastRow() { return 5; },
        getFilter() {
          return { removeColumnFilterCriteria(col) { removed.push(col); } };
        },
      },
    },
  });

  sandbox.clearQuickFilter();

  assert.deepEqual(removed, [3, 7, 8]);
});

test('clearTransactionDateFilter removes only date criteria and preserves account state', () => {
  const removed = [];
  const { sandbox, documentProperties } = loadCode({
    sheetsByName: {
      Transactions: {
        getLastRow() { return 5; },
        getFilter() {
          return { removeColumnFilterCriteria(col) { removed.push(col); } };
        },
      },
    },
  });

  documentProperties.set('QUICK_FILTER_FROM', '2025-01');
  documentProperties.set('QUICK_FILTER_TO', '2025-12');
  documentProperties.set('QUICK_FILTER_ACCOUNT_PREFIX', '[X]');

  sandbox.clearQuickDateFilter();

  assert.deepEqual(removed, [3]);
  assert.equal(documentProperties.has('QUICK_FILTER_FROM'), false);
  assert.equal(documentProperties.has('QUICK_FILTER_TO'), false);
  assert.equal(documentProperties.get('QUICK_FILTER_ACCOUNT_PREFIX'), '[X]');
});

test('getTransactionAccountNames returns sorted display names from Accounts sheet', () => {
  const { sandbox } = loadCode({
    sheetsByName: {
      Accounts: {
        getLastRow() { return 4; },
        getRange(_row, _col, numRows) {
          const rows = [['[X] Food - Groceries'], ['[A] Bank - Checking'], ['[X] Housing']];
          return { getValues() { return rows.slice(0, numRows); } };
        },
      },
    },
  });

  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.getQuickFilterAccountNames())), ['[A] Bank - Checking', '[X] Food - Groceries', '[X] Housing']);
});

test('applyTransactionAccountFilter sets OR formula covering both account columns for type-level prefix', () => {
  const filterCriteria = [];
  const { sandbox } = loadCode({
    sheetsByName: {
      Transactions: {
        getLastRow() { return 5; },
        getFilter() {
          return { setColumnFilterCriteria(col, criteria) { filterCriteria.push({ col, criteria }); } };
        },
      },
    },
  });

  sandbox.applyQuickAccountFilter('[X]');

  assert.equal(filterCriteria[0].col, 7);
  assert.equal(filterCriteria[0].criteria.formula, '=OR(LEFT(G2,4)="[X] ",LEFT(H2,4)="[X] ")');
});

test('applyTransactionAccountFilter sets OR formula covering both account columns for sub-level prefix', () => {
  const filterCriteria = [];
  const { sandbox } = loadCode({
    sheetsByName: {
      Transactions: {
        getLastRow() { return 5; },
        getFilter() {
          return { setColumnFilterCriteria(col, criteria) { filterCriteria.push({ col, criteria }); } };
        },
      },
    },
  });

  sandbox.applyQuickAccountFilter('[X] Food');

  assert.equal(filterCriteria[0].col, 7);
  assert.equal(filterCriteria[0].criteria.formula, '=OR(G2="[X] Food",LEFT(G2,11)="[X] Food - ",H2="[X] Food",LEFT(H2,11)="[X] Food - ")');
});

test('applyTransactionAccountFilter sets blank destination formula', () => {
  const filterCriteria = [];
  const { sandbox } = loadCode({
    sheetsByName: {
      Transactions: {
        getLastRow() { return 5; },
        getFilter() {
          return { setColumnFilterCriteria(col, criteria) { filterCriteria.push({ col, criteria }); } };
        },
      },
    },
  });

  sandbox.applyQuickAccountFilter('__blank__');

  assert.equal(filterCriteria[0].col, 7);
  assert.equal(filterCriteria[0].criteria.formula, '=H2=""');
});

test('applyTransactionAccountFilter persists prefix in document properties', () => {
  const { sandbox, documentProperties } = loadCode({
    sheetsByName: {
      Transactions: {
        getLastRow() { return 5; },
        getFilter() { return { setColumnFilterCriteria() {} }; },
      },
    },
  });

  sandbox.applyQuickAccountFilter('[X]');

  assert.equal(documentProperties.get('QUICK_FILTER_ACCOUNT_PREFIX'), '[X]');
});

test('clearTransactionAccountFilter removes criteria from all quickFilter:account columns', () => {
  const removed = [];
  const { sandbox } = loadCode({
    sheetsByName: {
      Transactions: {
        getLastRow() { return 5; },
        getFilter() {
          return { removeColumnFilterCriteria(col) { removed.push(col); } };
        },
      },
    },
  });

  sandbox.clearQuickAccountFilter();

  assert.deepEqual(removed, [7, 8]);
});

test('applyTransactionQuickFilter persists from/to in document properties', () => {
  const { sandbox, documentProperties } = loadCode({
    sheetsByName: {
      Transactions: {
        getLastRow() { return 5; },
        getFilter() { return { setColumnFilterCriteria() {} }; },
      },
    },
  });

  sandbox.applyQuickDateFilter('2025-03', '2025-12');

  assert.equal(documentProperties.get('QUICK_FILTER_FROM'), '2025-03');
  assert.equal(documentProperties.get('QUICK_FILTER_TO'), '2025-12');
});

test('clearTransactionQuickFilter clears all persisted filter state', () => {
  const { sandbox, documentProperties } = loadCode({
    sheetsByName: {
      Transactions: {
        getLastRow() { return 5; },
        getFilter() { return { removeColumnFilterCriteria() {} }; },
      },
    },
  });

  documentProperties.set('QUICK_FILTER_FROM', '2025-01');
  documentProperties.set('QUICK_FILTER_TO', '2025-12');
  documentProperties.set('QUICK_FILTER_ACCOUNT_PREFIX', '[X]');

  sandbox.clearQuickFilter();

  assert.equal(documentProperties.has('QUICK_FILTER_FROM'), false);
  assert.equal(documentProperties.has('QUICK_FILTER_TO'), false);
  assert.equal(documentProperties.has('QUICK_FILTER_ACCOUNT_PREFIX'), false);
});

test('applyQuickDateFilter also filters Balances assertion_date column', () => {
  const txCriteria = [];
  const balCriteria = [];
  const { sandbox } = loadCode({
    sheetsByName: {
      Transactions: {
        getLastRow() { return 5; },
        getFilter() { return { setColumnFilterCriteria(col, c) { txCriteria.push({ col, c }); } }; },
      },
      Balances: {
        getLastRow() { return 5; },
        getFilter() { return { setColumnFilterCriteria(col, c) { balCriteria.push({ col, c }); } }; },
      },
    },
  });

  sandbox.applyQuickDateFilter('2026-01', '2026-12');

  assert.equal(txCriteria.length, 1);
  assert.equal(txCriteria[0].col, 3); // transaction_date
  assert.equal(balCriteria.length, 1);
  assert.equal(balCriteria[0].col, 3); // assertion_date
  assert.ok(balCriteria[0].c.formula.includes('202601'));
});

test('clearQuickDateFilter removes date filter from Balances', () => {
  const txRemoved = [];
  const balRemoved = [];
  const { sandbox } = loadCode({
    sheetsByName: {
      Transactions: {
        getLastRow() { return 5; },
        getFilter() { return { removeColumnFilterCriteria(col) { txRemoved.push(col); } }; },
      },
      Balances: {
        getLastRow() { return 5; },
        getFilter() { return { removeColumnFilterCriteria(col) { balRemoved.push(col); } }; },
      },
    },
  });

  sandbox.clearQuickDateFilter();

  assert.deepEqual(txRemoved, [3]); // transaction_date
  assert.deepEqual(balRemoved, [3]); // assertion_date
});

test('applyQuickAccountFilter also filters Balances account column', () => {
  const balCriteria = [];
  const { sandbox } = loadCode({
    sheetsByName: {
      Transactions: {
        getLastRow() { return 5; },
        getFilter() { return { setColumnFilterCriteria() {} }; },
      },
      Balances: {
        getLastRow() { return 5; },
        getFilter() { return { setColumnFilterCriteria(col, c) { balCriteria.push({ col, c }); } }; },
      },
      Accounts: {
        getLastRow() { return 5; },
        getFilter() { return { setColumnFilterCriteria() {} }; },
      },
    },
  });

  sandbox.applyQuickAccountFilter('[X]');

  assert.equal(balCriteria.length, 1);
  assert.equal(balCriteria[0].col, 4); // account
  assert.ok(balCriteria[0].c.formula.includes('"[X] "'));
});

test('applyQuickAccountFilter also filters Accounts account_name column', () => {
  const accCriteria = [];
  const { sandbox } = loadCode({
    sheetsByName: {
      Transactions: {
        getLastRow() { return 5; },
        getFilter() { return { setColumnFilterCriteria() {} }; },
      },
      Balances: {
        getLastRow() { return 5; },
        getFilter() { return { setColumnFilterCriteria() {} }; },
      },
      Accounts: {
        getLastRow() { return 5; },
        getFilter() { return { setColumnFilterCriteria(col, c) { accCriteria.push({ col, c }); } }; },
      },
    },
  });

  sandbox.applyQuickAccountFilter('[X] Food');

  assert.equal(accCriteria.length, 1);
  assert.equal(accCriteria[0].col, 2); // account_name
  assert.ok(accCriteria[0].c.formula.includes('"[X] Food"'));
});

test('applyQuickAccountFilter skips __blank__ for single-column sheets', () => {
  const balCriteria = [];
  const accCriteria = [];
  const { sandbox } = loadCode({
    sheetsByName: {
      Transactions: {
        getLastRow() { return 5; },
        getFilter() { return { setColumnFilterCriteria() {} }; },
      },
      Balances: {
        getLastRow() { return 5; },
        getFilter() { return { setColumnFilterCriteria(col, c) { balCriteria.push({ col, c }); } }; },
      },
      Accounts: {
        getLastRow() { return 5; },
        getFilter() { return { setColumnFilterCriteria(col, c) { accCriteria.push({ col, c }); } }; },
      },
    },
  });

  sandbox.applyQuickAccountFilter('__blank__');

  assert.equal(balCriteria.length, 0);
  assert.equal(accCriteria.length, 0);
});

test('clearQuickAccountFilter removes filter from Balances and Accounts', () => {
  const balRemoved = [];
  const accRemoved = [];
  const { sandbox } = loadCode({
    sheetsByName: {
      Transactions: {
        getLastRow() { return 5; },
        getFilter() { return { removeColumnFilterCriteria() {} }; },
      },
      Balances: {
        getLastRow() { return 5; },
        getFilter() { return { removeColumnFilterCriteria(col) { balRemoved.push(col); } }; },
      },
      Accounts: {
        getLastRow() { return 5; },
        getFilter() { return { removeColumnFilterCriteria(col) { accRemoved.push(col); } }; },
      },
    },
  });

  sandbox.clearQuickAccountFilter();

  assert.deepEqual(balRemoved, [4]); // account
  assert.deepEqual(accRemoved, [2]); // account_name
});

test('clearQuickFilter removes date and account criteria from all sheets', () => {
  const removed = { Transactions: [], Balances: [], Accounts: [] };
  const { sandbox } = loadCode({
    sheetsByName: {
      Transactions: {
        getLastRow() { return 5; },
        getFilter() { return { removeColumnFilterCriteria(col) { removed.Transactions.push(col); } }; },
      },
      Balances: {
        getLastRow() { return 5; },
        getFilter() { return { removeColumnFilterCriteria(col) { removed.Balances.push(col); } }; },
      },
      Accounts: {
        getLastRow() { return 5; },
        getFilter() { return { removeColumnFilterCriteria(col) { removed.Accounts.push(col); } }; },
      },
    },
  });

  sandbox.clearQuickFilter();

  assert.deepEqual(removed.Transactions.sort((a, b) => a - b), [3, 7, 8]); // date, source, destination
  assert.deepEqual(removed.Balances.sort((a, b) => a - b), [3, 4]); // assertion_date, account
  assert.deepEqual(removed.Accounts, [2]); // account_name
});

test('getQuickFilterSidebarData returns combined years, account names, and persisted filter state', () => {
  const dates = [new Date(Date.UTC(2025, 5, 1))];
  const { sandbox, documentProperties } = loadCode({
    sheetsByName: {
      Transactions: {
        getLastRow() { return 2; },
        getRange(_row, _col, numRows) {
          return { getValues() { return dates.slice(0, numRows).map((d) => [d]); } };
        },
      },
      Accounts: {
        getLastRow() { return 2; },
        getRange(_row, _col, numRows) {
          return { getValues() { return [['[X] Food']].slice(0, numRows); } };
        },
      },
    },
  });

  documentProperties.set('QUICK_FILTER_FROM', '2025-01');
  documentProperties.set('QUICK_FILTER_TO', '2025-12');
  documentProperties.set('QUICK_FILTER_ACCOUNT_PREFIX', '[X]');

  const data = sandbox.getQuickFilterSidebarData();

  assert.deepEqual(data.years, [2025]);
  assert.deepEqual(JSON.parse(JSON.stringify(data.accountNames)), ['[X] Food']);
  assert.equal(data.from, '2025-01');
  assert.equal(data.to, '2025-12');
  assert.equal(data.accountPrefix, '[X]');
});
