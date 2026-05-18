const test = require('node:test');
const assert = require('node:assert/strict');

const { loadCode, makeFakeSheet_ } = require('./_harness');

// Shared config: alpha=col1, beta=col2, gamma=col3, delta=col4
// beta+gamma are adjacent; alpha and delta are non-adjacent to each other.
function makeTestConfig(sandbox) {
  return sandbox.buildSheetConfig_('test', 'Test', { alpha: {}, beta: {}, gamma: {}, delta: {} });
}

// ---------------------------------------------------------------------------
// setHeaders
// ---------------------------------------------------------------------------

test('setHeaders writes sheetConfig.headers to row 1', () => {
  const { sandbox } = loadCode();
  const config = sandbox.buildSheetConfig_('test', 'Test', { x: {}, y: {}, z: {} });
  const sheet = makeFakeSheet_();
  sandbox.managedSheet_(sheet, config).setHeaders();
  const call = sheet.calls.find((c) => c.method === 'setValues' && c.row === 1);
  assert.ok(call, 'setValues on row 1 expected');
  assert.deepEqual(JSON.parse(JSON.stringify(call.values)), [['x', 'y', 'z']]);
  assert.equal(call.col, 1);
  assert.equal(call.numCols, 3);
});

// ---------------------------------------------------------------------------
// setRow / setRows
// ---------------------------------------------------------------------------

test('setRow writes a single row to the correct row number', () => {
  const { sandbox } = loadCode();
  const config = makeTestConfig(sandbox);
  const sheet = makeFakeSheet_();
  sandbox.managedSheet_(sheet, config).setRow(5, { alpha: 'a', beta: 'b', gamma: 'c', delta: 'd' });
  const call = sheet.calls.find((c) => c.method === 'setValues');
  assert.equal(call.row, 5);
  assert.deepEqual(JSON.parse(JSON.stringify(call.values)), [['a', 'b', 'c', 'd']]);
});

test('setRow ignores extra fields and defaults missing ones to empty string', () => {
  const { sandbox } = loadCode();
  const config = makeTestConfig(sandbox);
  const sheet = makeFakeSheet_();
  sandbox.managedSheet_(sheet, config).setRow(2, { alpha: 'a', __extra: 'ignored' });
  const call = sheet.calls.find((c) => c.method === 'setValues');
  assert.deepEqual(JSON.parse(JSON.stringify(call.values)), [['a', '', '', '']]);
});

test('setRows makes one getRange call spanning full span × all headers', () => {
  const { sandbox } = loadCode();
  const config = makeTestConfig(sandbox);
  const sheet = makeFakeSheet_();
  sandbox.managedSheet_(sheet, config).setRows({ start: 3, count: 2 }, [
    { alpha: 'a1', beta: 'b1', gamma: 'c1', delta: 'd1' },
    { alpha: 'a2', beta: 'b2', gamma: 'c2', delta: 'd2' },
  ]);
  assert.equal(sheet.calls.length, 1);
  const call = sheet.calls[0];
  assert.equal(call.row, 3);
  assert.equal(call.col, 1);
  assert.equal(call.numRows, 2);
  assert.equal(call.numCols, 4);
  assert.deepEqual(JSON.parse(JSON.stringify(call.values)), [
    ['a1', 'b1', 'c1', 'd1'],
    ['a2', 'b2', 'c2', 'd2'],
  ]);
});

test('setRows with span.count=0 makes no getRange call', () => {
  const { sandbox } = loadCode();
  const config = makeTestConfig(sandbox);
  const sheet = makeFakeSheet_();
  sandbox.managedSheet_(sheet, config).setRows({ start: 2, count: 0 }, []);
  assert.equal(sheet.calls.length, 0);
});

test('setRows skips the issueHeader column when issueHeader is the last header', () => {
  const { sandbox } = loadCode();
  // Config with issues as the last column — formula-managed, must not be written by setRows.
  const config = sandbox.buildSheetConfig_('test', 'Test', { alpha: {}, beta: {}, issues: {} });
  const sheet = makeFakeSheet_();
  sandbox.managedSheet_(sheet, config).setRows({ start: 2, count: 1 }, [
    { alpha: 'a', beta: 'b', issues: 'should-be-ignored' },
  ]);
  assert.equal(sheet.calls.length, 1);
  const call = sheet.calls[0];
  assert.equal(call.numCols, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(call.values)), [['a', 'b']]);
});

// ---------------------------------------------------------------------------
// setFields
// ---------------------------------------------------------------------------

test('setFields single field: one getRange call at correct column', () => {
  const { sandbox } = loadCode();
  const config = makeTestConfig(sandbox);
  const sheet = makeFakeSheet_();
  sandbox.managedSheet_(sheet, config).setFields({ start: 2, count: 3 }, { gamma: 'val' });
  assert.equal(sheet.calls.length, 1);
  const call = sheet.calls[0];
  assert.equal(call.col, 3);
  assert.equal(call.row, 2);
  assert.equal(call.numRows, 3);
  assert.equal(call.numCols, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(call.values)), [['val'], ['val'], ['val']]);
});

test('setFields two adjacent fields: one getRange call (batched)', () => {
  const { sandbox } = loadCode();
  const config = makeTestConfig(sandbox);
  const sheet = makeFakeSheet_();
  sandbox.managedSheet_(sheet, config).setFields({ start: 2, count: 2 }, { beta: 'B', gamma: 'C' });
  assert.equal(sheet.calls.length, 1);
  const call = sheet.calls[0];
  assert.equal(call.col, 2);
  assert.equal(call.numCols, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(call.values)), [['B', 'C'], ['B', 'C']]);
});

test('setFields two non-adjacent fields: two getRange calls', () => {
  const { sandbox } = loadCode();
  const config = makeTestConfig(sandbox);
  const sheet = makeFakeSheet_();
  // alpha (col 1) and delta (col 4) are non-adjacent
  sandbox.managedSheet_(sheet, config).setFields({ start: 2, count: 1 }, { alpha: 'A', delta: 'D' });
  assert.equal(sheet.calls.length, 2);
  const cols = sheet.calls.map((c) => c.col).sort((a, b) => a - b);
  assert.deepEqual(cols, [1, 4]);
});

test('setFields with span.count=0 makes no getRange call', () => {
  const { sandbox } = loadCode();
  const config = makeTestConfig(sandbox);
  const sheet = makeFakeSheet_();
  sandbox.managedSheet_(sheet, config).setFields({ start: 2, count: 0 }, { alpha: 'x' });
  assert.equal(sheet.calls.length, 0);
});

test('setFields silently ignores unknown headers', () => {
  const { sandbox } = loadCode();
  const config = makeTestConfig(sandbox);
  const sheet = makeFakeSheet_();
  sandbox.managedSheet_(sheet, config).setFields({ start: 2, count: 1 }, { nonexistent: 'x' });
  assert.equal(sheet.calls.length, 0);
});

// ---------------------------------------------------------------------------
// setColumnFormulas
// ---------------------------------------------------------------------------

test('setColumnFormulas calls setFormulas with correct row numbers', () => {
  const { sandbox } = loadCode();
  const config = makeTestConfig(sandbox);
  const sheet = makeFakeSheet_();
  sandbox.managedSheet_(sheet, config).setColumnFormulas(
    { start: 3, count: 3 },
    'beta',
    function(row) { return '=ROW_' + row; }
  );
  const call = sheet.calls.find((c) => c.method === 'setFormulas');
  assert.ok(call);
  assert.equal(call.col, 2);
  assert.equal(call.row, 3);
  assert.equal(call.numRows, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(call.formulas)), [['=ROW_3'], ['=ROW_4'], ['=ROW_5']]);
});

test('setColumnFormulas with span.count=0 makes no call', () => {
  const { sandbox } = loadCode();
  const config = makeTestConfig(sandbox);
  const sheet = makeFakeSheet_();
  sandbox.managedSheet_(sheet, config).setColumnFormulas({ start: 2, count: 0 }, 'alpha', () => '=1');
  assert.equal(sheet.calls.length, 0);
});

// ---------------------------------------------------------------------------
// getRows / getRow
// ---------------------------------------------------------------------------

test('getRows (all columns) returns objects keyed by header name', () => {
  const { sandbox } = loadCode();
  const config = makeTestConfig(sandbox);
  const sheet = makeFakeSheet_(function() {
    return [['a', 'b', 'c', 'd'], ['e', 'f', 'g', 'h']];
  });
  const rows = sandbox.managedSheet_(sheet, config).getRows({ start: 2, count: 2 });
  assert.deepEqual(JSON.parse(JSON.stringify(rows)), [
    { alpha: 'a', beta: 'b', gamma: 'c', delta: 'd' },
    { alpha: 'e', beta: 'f', gamma: 'g', delta: 'h' },
  ]);
});

test('getRows with headerSubset reads minimal column rect', () => {
  const { sandbox } = loadCode();
  const config = makeTestConfig(sandbox);
  let capturedCall = null;
  const sheet = makeFakeSheet_(function(row, col, numRows, numCols) {
    capturedCall = { row, col, numRows, numCols };
    // Return values for the minimal rect (beta=col2, gamma=col3)
    return [['b_val', 'c_val']];
  });
  const rows = sandbox.managedSheet_(sheet, config).getRows({ start: 2, count: 1 }, ['beta', 'gamma']);
  // Should read cols 2..3 only (minCol=2, maxCol=3)
  assert.equal(capturedCall.col, 2);
  assert.equal(capturedCall.numCols, 2);
  // Should return only the requested headers
  assert.deepEqual(JSON.parse(JSON.stringify(rows)), [{ beta: 'b_val', gamma: 'c_val' }]);
});

test('getRow delegates to getRows with count=1 and returns single object', () => {
  const { sandbox } = loadCode();
  const config = makeTestConfig(sandbox);
  const sheet = makeFakeSheet_(function() { return [['x', 'y', 'z', 'w']]; });
  const row = sandbox.managedSheet_(sheet, config).getRow(4);
  assert.deepEqual(JSON.parse(JSON.stringify(row)), { alpha: 'x', beta: 'y', gamma: 'z', delta: 'w' });
});

// ---------------------------------------------------------------------------
// setColumnValidation
// ---------------------------------------------------------------------------

test('setColumnValidation calls setDataValidation on correct column range', () => {
  const { sandbox } = loadCode();
  const config = makeTestConfig(sandbox);
  const sheet = makeFakeSheet_();
  const rule = { kind: 'fakeRule' };
  sandbox.managedSheet_(sheet, config).setColumnValidation({ start: 2, count: 5 }, 'gamma', rule);
  const call = sheet.calls.find((c) => c.method === 'setDataValidation');
  assert.ok(call);
  assert.equal(call.row, 2);
  assert.equal(call.col, 3);
  assert.equal(call.numRows, 5);
  assert.equal(call.numCols, 1);
});

// ---------------------------------------------------------------------------
// clearColumnValidations
// ---------------------------------------------------------------------------

test('clearColumnValidations uses getRangeList with correct A1 notations', () => {
  const { sandbox } = loadCode();
  const config = makeTestConfig(sandbox);
  const sheet = makeFakeSheet_();
  sandbox.managedSheet_(sheet, config).clearColumnValidations({ start: 2, count: 4 }, ['alpha', 'delta']);
  // alpha=col1='A', delta=col4='D', rows 2..5
  const rangeListCall = sheet.rangeListCalls[0];
  assert.ok(rangeListCall);
  assert.deepEqual(JSON.parse(JSON.stringify(rangeListCall.notations)), ['A2:A5', 'D2:D5']);
  const clearCall = sheet.calls.find((c) => c.method === 'rangeListClearDataValidations');
  assert.ok(clearCall);
});

test('clearColumnValidations falls back to individual getRange when getRangeList absent', () => {
  const { sandbox } = loadCode();
  const config = makeTestConfig(sandbox);
  const calls = [];
  const sheet = {
    getLastRow() { return 10; },
    getMaxRows() { return 10; },
    getRange(row, col, numRows = 1, numCols = 1) {
      return {
        clearDataValidations() { calls.push({ method: 'clearDataValidations', row, col, numRows, numCols }); return this; },
      };
    },
  };
  sandbox.managedSheet_(sheet, config).clearColumnValidations({ start: 3, count: 2 }, ['beta', 'gamma']);
  const clearCalls = calls.filter((c) => c.method === 'clearDataValidations');
  assert.equal(clearCalls.length, 2);
});

test('clearColumnValidations with span.count=0 makes no call', () => {
  const { sandbox } = loadCode();
  const config = makeTestConfig(sandbox);
  const sheet = makeFakeSheet_();
  sandbox.managedSheet_(sheet, config).clearColumnValidations({ start: 2, count: 0 }, ['alpha']);
  assert.equal(sheet.calls.length, 0);
  assert.equal(sheet.rangeListCalls.length, 0);
});

// ---------------------------------------------------------------------------
// activateCell
// ---------------------------------------------------------------------------

test('activateCell calls activate on the correct cell', () => {
  const { sandbox } = loadCode();
  const config = makeTestConfig(sandbox);
  const sheet = makeFakeSheet_();
  sandbox.managedSheet_(sheet, config).activateCell(7, 'delta');
  const call = sheet.calls.find((c) => c.method === 'activate');
  assert.ok(call);
  assert.equal(call.row, 7);
  assert.equal(call.col, 4);
});

// ---------------------------------------------------------------------------
// createFilter
// ---------------------------------------------------------------------------

test('createFilter returns null when sheet has 1 or fewer rows', () => {
  const { sandbox } = loadCode();
  const config = makeTestConfig(sandbox);
  const sheet = makeFakeSheet_();
  sheet.getLastRow = function() { return 1; };
  const result = sandbox.managedSheet_(sheet, config).createFilter();
  assert.equal(result, null);
  assert.equal(sheet.calls.filter((c) => c.method === 'createFilter').length, 0);
});

test('createFilter calls createFilter on range(1,1,lastRow,numHeaders)', () => {
  const { sandbox } = loadCode();
  const config = makeTestConfig(sandbox);
  const sheet = makeFakeSheet_();
  sheet.getLastRow = function() { return 5; };
  const result = sandbox.managedSheet_(sheet, config).createFilter();
  const call = sheet.calls.find((c) => c.method === 'createFilter');
  assert.ok(call);
  assert.equal(call.row, 1);
  assert.equal(call.col, 1);
  assert.equal(call.numRows, 5);
  assert.equal(call.numCols, 4);
  assert.deepEqual(result, { filterSentinel: true });
});

// ---------------------------------------------------------------------------
// getColumnRange
// ---------------------------------------------------------------------------

test('getColumnRange returns range at (span.start, col, span.count, 1)', () => {
  const { sandbox } = loadCode();
  const config = makeTestConfig(sandbox);
  let capturedArgs = null;
  const sheet = {
    getRange(row, col, numRows, numCols) {
      capturedArgs = { row, col, numRows, numCols };
      return {};
    },
    getRangeList() { return {}; },
    getLastRow() { return 10; },
    getMaxRows() { return 10; },
  };
  sandbox.managedSheet_(sheet, config).getColumnRange({ start: 3, count: 5 }, 'gamma');
  assert.deepEqual(capturedArgs, { row: 3, col: 3, numRows: 5, numCols: 1 });
});

// ---------------------------------------------------------------------------
// getFullDataRange
// ---------------------------------------------------------------------------

test('getFullDataRange returns range at (2, 1, maxRows-1, numHeaders)', () => {
  const { sandbox } = loadCode();
  const config = makeTestConfig(sandbox);
  let capturedArgs = null;
  const sheet = {
    getRange(row, col, numRows, numCols) {
      capturedArgs = { row, col, numRows, numCols };
      return {};
    },
    getRangeList() { return {}; },
    getLastRow() { return 10; },
    getMaxRows() { return 8; },
  };
  sandbox.managedSheet_(sheet, config).getFullDataRange();
  assert.deepEqual(capturedArgs, { row: 2, col: 1, numRows: 7, numCols: 4 });
});

test('getFullDataRange clamps to at least 1 row when sheet is empty', () => {
  const { sandbox } = loadCode();
  const config = makeTestConfig(sandbox);
  let capturedArgs = null;
  const sheet = {
    getRange(row, col, numRows, numCols) {
      capturedArgs = { row, col, numRows, numCols };
      return {};
    },
    getRangeList() { return {}; },
    getLastRow() { return 1; },
    getMaxRows() { return 1; },
  };
  sandbox.managedSheet_(sheet, config).getFullDataRange();
  assert.ok(capturedArgs.numRows >= 1, 'numRows should be at least 1');
});
