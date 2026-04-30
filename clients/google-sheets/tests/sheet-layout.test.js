const test = require('node:test');
const assert = require('node:assert/strict');

const { loadCode, makeRowStoreSheet_ } = require('./_harness');

test('writeSheet_ expands older narrower sheets before writing headers', () => {
  const operations = [];
  const { sandbox } = loadCode();
  const headers = sandbox.getSheetConfigByName_('Transactions').headers;
  const fakeSheet = {
    getMaxColumns() { return 8; },
    getMaxRows() { return 1; },
    insertColumnsAfter(column, howMany) { operations.push({ type: 'insertColumnsAfter', column, howMany }); },
    insertRowsAfter(row, howMany) { operations.push({ type: 'insertRowsAfter', row, howMany }); },
    clearContents() { operations.push({ type: 'clearContents' }); },
    getRange(row, column, numRows, numCols) {
      return { setValues(values) { operations.push({ type: 'setValues', row, column, numRows, numCols, values }); } };
    },
  };

  sandbox.writeSheet_(fakeSheet, headers, []);

  assert.deepEqual(JSON.parse(JSON.stringify(operations.slice(0, 3))), [
    { type: 'insertColumnsAfter', column: 8, howMany: 5 },
    { type: 'clearContents' },
    { type: 'setValues', row: 1, column: 1, numRows: 1, numCols: 13, values: [headers] },
  ]);
});

test('applyManagedSheetLayout_ expands narrower managed sheets and reapplies configured hidden columns', () => {
  const { sandbox } = loadCode({ SpreadsheetApp: { WrapStrategy: { CLIP: 'CLIP' } } });
  const cases = [
    {
      sheetName: 'Transactions',
      initialColumns: 8,
      expectedInsert: { column: 8, howMany: 5 },
      expectedHide: [1, 5, 12],
    },
    {
      sheetName: 'Accounts',
      initialColumns: 2,
      expectedInsert: { column: 2, howMany: 1 },
      expectedHide: [2],
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
    getMaxColumns() { return 13; },
    getLastRow() { return 5; },
    getMaxRows() { return 5; },
    showColumns(column, count) { operations.push({ type: 'show', column, count }); },
    hideColumns(column) { operations.push({ type: 'hide', column }); },
  };

  sandbox.applySheetHiddenColumns_(fakeSheet, sandbox.getSheetConfigByName_('Transactions'));

  assert.deepEqual(JSON.parse(JSON.stringify(operations)), [
    { type: 'show', column: 1, count: 13 },
    { type: 'hide', column: 1 },
    { type: 'hide', column: 5 },
    { type: 'hide', column: 12 },
  ]);
});

test('applySheetDirectFormatting_ applies grouped formatting from config metadata', () => {
  const operations = [];
  const { sandbox } = loadCode({ SpreadsheetApp: { WrapStrategy: { CLIP: 'CLIP' } } });
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
  const issuesWrap = operations.find((op) => op.type === 'rangeListWrap' && op.notations.includes('M1:M5'));
  const dateFormat = operations.find((op) => op.type === 'rangeListNumberFormat' && op.notations.includes('B2:B5'));
  assert.equal(leftAlign.value, 'left');
  assert.equal(issuesWrap.value, true);
  assert.equal(dateFormat.value, 'yyyy-mm-dd');
});

test('ensureSheetConditionalFormatting_ adds narration italics rules from hidden scope', () => {
  const operations = [];
  const { sandbox } = loadCode();
  const fakeSheet = makeRowStoreSheet_(sandbox, new Map([[2, { transaction_name: 'transactions/txn_1' }]]), operations);

  sandbox.ensureSheetConditionalFormatting_(fakeSheet);

  const rules = operations.find((op) => op.type === 'setConditionalFormatRules').rules;
  const italicRules = rules.filter((rule) => rule.italic !== null);
  assert.deepEqual(JSON.parse(JSON.stringify(italicRules.map((rule) => ({ formula: rule.formula, italic: rule.italic })))), [
    { formula: '=$E2="post"', italic: true },
    { formula: '=$E2="txn"', italic: false },
  ]);
});

test('ensureSheetConditionalFormatting_ drops stale managed formulas from old column positions', () => {
  const operations = [];
  const { sandbox } = loadCode();
  const staleRule = {
    getBooleanCondition() {
      return {
        getCriteriaType() { return sandbox.SpreadsheetApp.BooleanCriteria.CUSTOM_FORMULA; },
        getCriteriaValues() { return ['=COLUMN()=4']; },
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
  const fakeSheet = makeRowStoreSheet_(sandbox, new Map([[2, { transaction_name: 'transactions/txn_1' }]]), operations);
  fakeSheet.getConditionalFormatRules = function() { return [staleRule, keptRule]; };

  sandbox.ensureSheetConditionalFormatting_(fakeSheet);

  const rules = operations.find((op) => op.type === 'setConditionalFormatRules').rules;
  assert.equal(rules.includes(staleRule), false);
  assert.equal(rules.includes(keptRule), true);
});
