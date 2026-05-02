const test = require('node:test');
const assert = require('node:assert/strict');

const { loadCode, makeRowStoreSheet_ } = require('./_harness');

test('ensureTransactionSheetFilter_ creates a filter covering all transaction columns', () => {
  const operations = [];
  const rowStore = new Map([[2, {
    resource_name: 'transactions/txn_1', transaction_date: new Date('2026-04-19T00:00:00.000Z'),
    payee: 'Migros', narration: 'Groceries', source_account_name: 'Assets:Bank:Checking',
    destination_account_name: 'Expenses:Food', amount: 84.25, split_off_amount: '',
    symbol: 'CHF', status: '', issues: '', last_error: '',
  }]]);
  const { sandbox } = loadCode();
  const sheet = makeRowStoreSheet_(sandbox, rowStore, operations);

  sandbox.ensureTransactionSheetFilter_(sheet);

  const filterOp = operations.find((op) => op.type === 'createFilter');
  assert.ok(filterOp, 'createFilter should have been called');
  assert.equal(filterOp.row, 1);
  assert.equal(filterOp.numRows, 2);
});

test('ensureTransactionSheetFilter_ restores existing filter criteria on the new filter', () => {
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

  sandbox.ensureTransactionSheetFilter_(sheet);

  assert.equal(restored.length, 2);
  assert.deepEqual(restored.map((r) => r.col).sort((a, b) => a - b), [3, 6]);
});

test('ensureTransactionSheetFilter_ tolerates a legacy narrower filter range', () => {
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

  sandbox.ensureTransactionSheetFilter_(sheet);

  assert.deepEqual(accessedColumns, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(restored, [{ col: 3, criteria: { formula: '=C2>0' } }]);
});

test('ensureTransactionSheetFilter_ restores hidden technical column criteria by header too', () => {
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
          return col === 5 ? { formula: '=$E2="txn"' } : null;
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

  sandbox.ensureTransactionSheetFilter_(sheet);

  assert.deepEqual(restored, [{ col: 5, criteria: { formula: '=$E2="txn"' } }]);
});

test('ensureTransactionSheetFilter_ reapplies persisted quick filters after rebuild', () => {
  const filterCriteria = [];
  const { sandbox, documentProperties } = loadCode();
  documentProperties.set('QUICK_FILTER_FROM', '2026-01');
  documentProperties.set('QUICK_FILTER_TO', '2026-12');
  documentProperties.set('QUICK_FILTER_ACCOUNT_PREFIX', '[X]');
  let activeFilter = {
    getRange() { return { getNumColumns() { return 13; } }; },
    getColumnFilterCriteria() { return null; },
    remove() {},
  };
  const sheet = {
    getLastRow() { return 3; },
    getFilter() {
      return activeFilter;
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
          activeFilter = {
            setColumnFilterCriteria(col, criteria) { filterCriteria.push({ col, criteria }); },
            removeColumnFilterCriteria() {},
          };
          return activeFilter;
        },
      };
    },
  };

  sandbox.SpreadsheetApp.getActiveSpreadsheet = function() {
    return { getSheetByName() { return sheet; } };
  };

  sandbox.ensureTransactionSheetFilter_(sheet);

  assert.equal(filterCriteria.length, 2);
  assert.equal(filterCriteria[0].col, 2);
  assert.equal(filterCriteria[1].col, 6);
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

  sandbox.applyTransactionQuickFilter('2026-01', '2026-12');

  assert.equal(filterCriteria[0].col, 2);
  assert.equal(filterCriteria[0].criteria.formula, '=AND(YEAR(B2)*100+MONTH(B2)>=202601,YEAR(B2)*100+MONTH(B2)<=202612)');
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

  sandbox.applyTransactionQuickFilter('2025-03', '2026-06');

  assert.equal(filterCriteria[0].criteria.formula, '=AND(YEAR(B2)*100+MONTH(B2)>=202503,YEAR(B2)*100+MONTH(B2)<=202606)');
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

  sandbox.clearTransactionQuickFilter();

  assert.deepEqual(removed, [2, 6, 7]);
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

  sandbox.clearTransactionDateFilter();

  assert.deepEqual(removed, [2]);
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

  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.getTransactionAccountNames())), ['[A] Bank - Checking', '[X] Food - Groceries', '[X] Housing']);
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

  sandbox.applyTransactionAccountFilter('[X]');

  assert.equal(filterCriteria[0].col, 6);
  assert.equal(filterCriteria[0].criteria.formula, '=OR(LEFT(F2,4)="[X] ",LEFT(G2,4)="[X] ")');
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

  sandbox.applyTransactionAccountFilter('[X] Food');

  assert.equal(filterCriteria[0].col, 6);
  assert.equal(filterCriteria[0].criteria.formula, '=OR(F2="[X] Food",LEFT(F2,11)="[X] Food - ",G2="[X] Food",LEFT(G2,11)="[X] Food - ")');
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

  sandbox.applyTransactionAccountFilter('__blank__');

  assert.equal(filterCriteria[0].col, 6);
  assert.equal(filterCriteria[0].criteria.formula, '=G2=""');
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

  sandbox.applyTransactionAccountFilter('[X]');

  assert.equal(documentProperties.get('QUICK_FILTER_ACCOUNT_PREFIX'), '[X]');
});

test('clearTransactionAccountFilter removes source_account_name filter criteria', () => {
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

  sandbox.clearTransactionAccountFilter();

  assert.deepEqual(removed, [6]);
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

  sandbox.applyTransactionQuickFilter('2025-03', '2025-12');

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

  sandbox.clearTransactionQuickFilter();

  assert.equal(documentProperties.has('QUICK_FILTER_FROM'), false);
  assert.equal(documentProperties.has('QUICK_FILTER_TO'), false);
  assert.equal(documentProperties.has('QUICK_FILTER_ACCOUNT_PREFIX'), false);
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
