const test = require('node:test');
const assert = require('node:assert/strict');

const { loadCode, makeRowStoreSheet_ } = require('./_harness');

test('writeSheet_ clears and writes without checking sheet capacity', () => {
  const operations = [];
  const { sandbox } = loadCode();
  const sheetConfig = sandbox.getSheetConfigByName_('Transactions');
  const fakeSheet = {
    clearContents() { operations.push({ type: 'clearContents' }); },
    getRange(row, column, numRows, numCols) {
      return { setValues(values) { operations.push({ type: 'setValues', row, column, numRows, numCols, values }); } };
    },
  };

  sandbox.writeSheet_(fakeSheet, sheetConfig, []);

  assert.deepEqual(JSON.parse(JSON.stringify(operations)), [
    { type: 'clearContents' },
    { type: 'setValues', row: 1, column: 1, numRows: 1, numCols: 12, values: [sheetConfig.headers] },
  ]);
});

test('ensureSheetCapacity_ expands undersized sheets before writing', () => {
  const operations = [];
  const { sandbox } = loadCode();
  let maxRows = 1;
  const fakeSheet = {
    getMaxRows() { return maxRows; },
    getMaxColumns() { return 26; },
    insertRowsAfter(row, howMany) {
      operations.push({ type: 'insertRowsAfter', row, howMany });
      maxRows += howMany;
    },
    insertColumnsAfter(col, howMany) {
      operations.push({ type: 'insertColumnsAfter', col, howMany });
    },
  };

  sandbox.ensureSheetCapacity_(fakeSheet, 14, 2);

  const expandOp = operations.find(function(op) { return op.type === 'insertRowsAfter'; });
  assert.ok(expandOp, 'should insert rows when sheet is too small');
  assert.equal(expandOp.row, 1);
});


test('applyManagedSheetLayout_ expands narrower managed sheets and reapplies configured hidden columns', () => {
  const { sandbox } = loadCode({ SpreadsheetApp: { WrapStrategy: { CLIP: 'CLIP' } } });
  const cases = [
    {
      sheetName: 'Transactions',
      initialColumns: 8,
      expectedInsert: { column: 8, howMany: 4 },
      expectedHide: [2, 6],
    },
    {
      sheetName: 'Accounts',
      initialColumns: 2,
      expectedInsert: { column: 2, howMany: 1 },
      expectedHide: [1],
    },
  ];

  cases.forEach(function(testCase) {
    const operations = [];
    let maxColumns = testCase.initialColumns;
    const fakeSheet = {
      getName() { return testCase.sheetName; },
      getMaxColumns() { return maxColumns; },
      getLastRow() { return 5; },
      getMaxRows() { return 5; },
      insertColumnsAfter(column, howMany) { maxColumns += howMany; operations.push({ type: 'insertColumnsAfter', column, howMany }); },
      insertRowsAfter(row, howMany) { operations.push({ type: 'insertRowsAfter', row, howMany }); },
      setColumnWidth() {},
      showColumns(column, count) { operations.push({ type: 'showColumns', column, count }); },
      hideColumns(column) { operations.push({ type: 'hideColumns', column }); },
      getRange() {
        return {
          setNote() { return this; },
          setBackground() { return this; },
          setFontWeight() { return this; },
          setHorizontalAlignment() { return this; },
          setWrap() { return this; },
          setWrapStrategy() { return this; },
          setNumberFormat() { return this; },
          protect() { return { setDescription() {}, setWarningOnly() {} }; },
        };
      },
      getConditionalFormatRules() { return []; },
      setConditionalFormatRules() {},
      getProtections() { return []; },
      getRangeList() {
        return {
          setBackground() { return this; },
          setFontWeight() { return this; },
          setHorizontalAlignment() { return this; },
          setWrap() { return this; },
          setWrapStrategy() { return this; },
          setNumberFormat() { return this; },
        };
      },
    };

    sandbox.applyManagedSheetLayout_(fakeSheet, sandbox.getSheetConfigByName_(testCase.sheetName));

    assert.deepEqual(JSON.parse(JSON.stringify(operations[0])), {
      type: 'insertColumnsAfter',
      column: testCase.expectedInsert.column,
      howMany: testCase.expectedInsert.howMany,
    });
    assert.deepEqual(
      JSON.parse(JSON.stringify(operations.filter((op) => op.type === 'hideColumns').map((op) => op.column))),
      testCase.expectedHide
    );
  });
});

test('applySheetHiddenColumns_ hides configured technical transaction columns', () => {
  const operations = [];
  const { sandbox } = loadCode();
  const fakeSheet = {
    getName() { return 'Transactions'; },
    getMaxColumns() { return 12; },
    getLastRow() { return 5; },
    getMaxRows() { return 5; },
    showColumns(column, count) { operations.push({ type: 'show', column, count }); },
    hideColumns(column) { operations.push({ type: 'hide', column }); },
  };

  sandbox.applySheetHiddenColumns_(fakeSheet, sandbox.getSheetConfigByName_('Transactions'));

  assert.deepEqual(JSON.parse(JSON.stringify(operations)), [
    { type: 'show', column: 1, count: 12 },
    { type: 'hide', column: 2 },
    { type: 'hide', column: 6 },
  ]);
});

test('applySheetDirectFormatting_ applies grouped formatting from config metadata', () => {
  const operations = [];
  const { sandbox } = loadCode({ SpreadsheetApp: { WrapStrategy: { CLIP: 'CLIP', OVERFLOW: 'OVERFLOW' } } });
  const fakeSheet = {
    getMaxRows() { return 5; },
    getRange() { return { setHorizontalAlignment() { return this; }, setWrap() { return this; }, setWrapStrategy() { return this; }, setNumberFormat() { return this; } }; },
    getRangeList(notations) {
      return {
        setHorizontalAlignment(value) { operations.push({ type: 'rangeListAlign', notations, value }); return this; },
        setWrap(value) { operations.push({ type: 'rangeListWrap', notations, value }); return this; },
        setWrapStrategy(value) { operations.push({ type: 'rangeListWrapStrategy', notations, value }); return this; },
        setNumberFormat(value) { operations.push({ type: 'rangeListNumberFormat', notations, value }); return this; },
      };
    },
  };

  sandbox.applySheetDirectFormatting_(fakeSheet, sandbox.getSheetConfigByName_('Transactions'));

  const leftAlign = operations.find((op) => op.type === 'rangeListAlign' && op.notations.includes('G1:G5'));
  const issuesWrap = operations.find((op) => op.type === 'rangeListWrap' && op.notations.includes('L1:L5'));
  const issuesWrapStrategy = operations.find((op) => op.type === 'rangeListWrapStrategy' && op.notations.includes('L1:L5'));
  const dateFormat = operations.find((op) => op.type === 'rangeListNumberFormat' && op.notations.includes('C2:C5'));
  assert.equal(leftAlign.value, 'left');
  assert.equal(issuesWrap.value, false);
  assert.equal(issuesWrapStrategy.value, 'OVERFLOW');
  assert.equal(dateFormat.value, 'yyyy-mm-dd');
});

test('ensureSheetConditionalFormatting_ keeps only issue-state background rules for transactions', () => {
  const operations = [];
  const { sandbox } = loadCode();
  const fakeSheet = makeRowStoreSheet_(sandbox, new Map([[2, { resource_name: 'transactions/txn_1' }]]), operations);

  sandbox.ensureSheetConditionalFormatting_(fakeSheet);

  const rules = operations.find((op) => op.type === 'setConditionalFormatRules').rules;
  const backgroundRules = rules.filter((rule) => rule.background);
  assert.deepEqual(JSON.parse(JSON.stringify(backgroundRules.map((rule) => ({ formula: rule.formula, background: rule.background })))), [
    { formula: '=$L2<>""', background: '#fee2e2' },
  ]);
});

test('ensureSheetConditionalFormatting_ keeps only issue-state background rules for non-transaction sheets', () => {
  const operations = [];
  const { sandbox } = loadCode();
  const accountsSheet = {
    getName() { return 'Accounts'; },
    getMaxColumns() { return 3; },
    getLastRow() { return 3; },
    getMaxRows() { return 3; },
    getRange() { return { setNote() { return this; }, setBackground() { return this; }, setFontWeight() { return this; }, setHorizontalAlignment() { return this; }, setWrap() { return this; }, setWrapStrategy() { return this; }, setNumberFormat() { return this; }, protect() { return { setDescription() {}, setWarningOnly() {} }; } }; },
    getRangeList() { return { setBackground() { return this; }, setFontWeight() { return this; }, setHorizontalAlignment() { return this; }, setWrap() { return this; }, setWrapStrategy() { return this; }, setNumberFormat() { return this; } }; },
    getConditionalFormatRules() { return []; },
    setConditionalFormatRules(rules) { operations.push({ type: 'setConditionalFormatRules', rules }); },
    getProtections() { return []; },
    showColumns() {},
    hideColumns() {},
  };

  sandbox.ensureSheetConditionalFormatting_(accountsSheet, sandbox.getSheetConfigByName_('Accounts'));

  const rules = operations.find((op) => op.type === 'setConditionalFormatRules').rules;
  const backgroundRules = rules.filter((rule) => rule.background);
  assert.deepEqual(JSON.parse(JSON.stringify(backgroundRules.map((rule) => ({ formula: rule.formula, background: rule.background })))), [
    { formula: '=$C2<>""', background: '#fee2e2' },
  ]);
});

test('ensureSheetConditionalFormatting_ drops stale managed formulas from old column positions', () => {
  const operations = [];
  const { sandbox } = loadCode();
  const staleRule = {
    getBooleanCondition() {
        return {
          getCriteriaType() { return sandbox.SpreadsheetApp.BooleanCriteria.CUSTOM_FORMULA; },
          getCriteriaValues() { return ['=$N2<>""']; },
        };
      },
    };
  const keptRule = {
    getBooleanCondition() {
      return {
        getCriteriaType() { return sandbox.SpreadsheetApp.BooleanCriteria.CUSTOM_FORMULA; },
        getCriteriaValues() { return ['=A1=TRUE']; },
      };
    },
  };
  const fakeSheet = makeRowStoreSheet_(sandbox, new Map([[2, { resource_name: 'transactions/txn_1' }]]), operations);
  fakeSheet.getConditionalFormatRules = function() { return [staleRule, keptRule]; };

  sandbox.ensureSheetConditionalFormatting_(fakeSheet);

  const rules = operations.find((op) => op.type === 'setConditionalFormatRules').rules;
  assert.equal(rules.includes(staleRule), false);
  assert.equal(rules.includes(keptRule), true);
});

test('refreshManagedLedgerSheetLayouts_ applies shared transaction reset steps', () => {
  const calls = [];
  const sheets = {
    Transactions: { name: 'Transactions' },
    Accounts: { name: 'Accounts' },
  };
  const { sandbox } = loadCode({
    SpreadsheetApp: {
      getActiveSpreadsheet() {
        return {
          getSheetByName(name) {
            return sheets[name] || null;
          },
        };
      },
    },
  });
  sandbox.applyManagedSheetLayout_ = function(sheet) {
    calls.push({ type: 'layout', sheet: sheet.name });
  };
  sandbox.refreshTransactionAccountValidation_ = function(sheet) {
    calls.push({ type: 'validation', sheet: sheet.name });
  };
  sandbox.applyActionColumnCheckboxes_ = function(sheet) {
    calls.push({ type: 'editCheckbox', sheet: sheet.name });
  };
  sandbox.ensureTransactionSheetFilter_ = function(sheet) {
    calls.push({ type: 'filter', sheet: sheet.name });
  };
  sandbox.ensureAccountsSheetFilter_ = function(sheet) {
    calls.push({ type: 'filter', sheet: sheet.name });
  };
  sandbox.reapplyPersistedQuickFilters_ = function() {
    calls.push({ type: 'reapplyFilters' });
  };

  sandbox.refreshManagedLedgerSheetLayouts_();

  assert.deepEqual(calls, [
    { type: 'layout', sheet: 'Transactions' },
    { type: 'validation', sheet: 'Transactions' },
    { type: 'editCheckbox', sheet: 'Transactions' },
    { type: 'filter', sheet: 'Transactions' },
    { type: 'layout', sheet: 'Accounts' },
    { type: 'filter', sheet: 'Accounts' },
    { type: 'reapplyFilters' },
  ]);
});

test('resetSheetLayouts delegates to shared managed layout refresh', () => {
  const alerts = [];
  const calls = [];
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
    },
  });
  sandbox.runUserAction_ = function(_label, work) {
    work();
  };
  sandbox.refreshManagedLedgerSheetLayouts_ = function() {
    calls.push('refreshManagedLedgerSheetLayouts');
  };

  sandbox.resetSheetLayouts();

  assert.deepEqual(calls, ['refreshManagedLedgerSheetLayouts']);
  assert.deepEqual(alerts, [{
    title: 'Reset Sheet Layouts',
    message: 'Layouts have been reset to their default configurations.',
  }]);
});
