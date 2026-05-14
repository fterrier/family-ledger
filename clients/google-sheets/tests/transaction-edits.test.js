const test = require('node:test');
const assert = require('node:assert/strict');

const { loadCode, makeRowStoreSheet_ } = require('./_harness');

test('performSplitForRow_ inserts a sibling row with duplicated destination account', () => {
  const operations = [];
  const rowStore = new Map([
    [2, {
      resource_name: 'transactions/txn_1',
      transaction_date: '2026-04-19',
      payee: 'Migros',
      narration: 'Groceries',
      source_account_name: 'Assets:Bank:Checking',
      destination_account_name: 'Expenses:Food',
      amount: 84.25,
      split_off_amount: '',
      symbol: 'CHF',
      status: '',
      last_error: '',
    }],
  ]);
  const { sandbox } = loadCode();
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, operations);
  fakeSheet.getActiveRange = function() {
    return { getRow() { return 3; }, getColumn() { return 9; } };
  };
  fakeSheet.getRange = function(row, column, numRows, numCols) {
    if (numRows === undefined) {
      return { activate() { operations.push({ type: 'activate', row: row, column: column }); } };
    }
    return makeRowStoreSheet_(sandbox, rowStore, operations).getRange(row, column, numRows, numCols);
  };
  sandbox.applyAccountValidationToRowNumbers_ = function(_sheet, rowNumbers) {
    operations.push({ type: 'applyValidation', rowNumbers: rowNumbers.slice() });
  };

  sandbox.performSplitForRow_(fakeSheet, 2, '34.25');

  assert.equal(rowStore.get(2).amount, 50);
  assert.equal(rowStore.get(3).amount, 34.25);
  assert.equal(rowStore.get(3).destination_account_name, 'Expenses:Food');
});

test('performSplitForRow_ splits a negative-amount row using a positive split amount', () => {
  const operations = [];
  const rowStore = new Map([
    [2, {
      resource_name: 'transactions/txn_1',
      transaction_date: '2026-04-19',
      payee: 'Employer',
      narration: 'Salary',
      source_account_name: 'Assets:Bank:Checking',
      destination_account_name: '[I] Salary',
      amount: -5000,
      split_off_amount: '',
      symbol: 'CHF',
      status: '',
      last_error: '',
    }],
  ]);
  const { sandbox } = loadCode();
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, operations);
  fakeSheet.getActiveRange = function() {
    return { getRow() { return 3; }, getColumn() { return 9; } };
  };
  fakeSheet.getRange = function(row, column, numRows, numCols) {
    if (numRows === undefined) {
      return { activate() { operations.push({ type: 'activate', row: row, column: column }); } };
    }
    return makeRowStoreSheet_(sandbox, rowStore, operations).getRange(row, column, numRows, numCols);
  };
  sandbox.applyAccountValidationToRowNumbers_ = function(_sheet, rowNumbers) {
    operations.push({ type: 'applyValidation', rowNumbers: rowNumbers.slice() });
  };

  sandbox.performSplitForRow_(fakeSheet, 2, '2000');

  assert.equal(rowStore.get(2).amount, -7000);
  assert.equal(rowStore.get(3).amount, 2000);
  assert.equal(rowStore.get(3).destination_account_name, '[I] Salary');
});

test('performSplitForRow_ writes 0 amount to sheet without coercing to blank', () => {
  const operations = [];
  const rowStore = new Map([
    [2, {
      resource_name: 'transactions/txn_1',
      transaction_date: '2026-04-19',
      payee: 'Migros',
      narration: 'Groceries',
      source_account_name: 'Assets:Bank:Checking',
      destination_account_name: 'Expenses:Food',
      amount: 84.25,
      split_off_amount: '0',
      symbol: 'CHF',
      status: '',
      last_error: '',
    }],
  ]);

  const { sandbox } = loadCode();
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, operations);
  fakeSheet.getActiveRange = function() {
    return { getRow() { return 3; }, getColumn() { return 9; } };
  };
  fakeSheet.getRange = function(row, column, numRows, numCols) {
    if (numRows === undefined) {
      return { activate() { operations.push({ type: 'activate', row: row, column: column }); } };
    }
    return makeRowStoreSheet_(sandbox, rowStore, operations).getRange(row, column, numRows, numCols);
  };
  sandbox.applyAccountValidationToRowNumbers_ = function() {};

  sandbox.performSplitForRow_(fakeSheet, 2, '0');

  assert.equal(rowStore.get(2).amount, 84.25);
  assert.equal(rowStore.get(3).amount, 0);
});



test('insertSplitRow_ focuses the newly inserted row in the specified column', () => {
  const operations = [];
  const rowStore = new Map([
    [2, {
      resource_name: 'transactions/txn_1',
      transaction_date: '2026-04-19',
      payee: 'Migros',
      narration: 'Groceries',
      source_account_name: 'Assets:Bank:Checking',
      destination_account_name: 'Expenses:Food',
      amount: 50,
      split_off_amount: '',
      symbol: 'CHF',
      status: '',
      last_error: '',
    }],
  ]);
  const { sandbox } = loadCode();
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, operations);
  fakeSheet.getRange = function(row, column, numRows, numCols) {
    if (numRows === undefined) {
      return { activate() { operations.push({ type: 'activate', row: row, column: column }); } };
    }
    return makeRowStoreSheet_(sandbox, rowStore, operations).getRange(row, column, numRows, numCols);
  };
  sandbox.applyAccountValidationToRowNumbers_ = function() {};
  const groupRows = [{ ...rowStore.get(2), __rowNumber: 2 }];

  sandbox.insertSplitRow_(fakeSheet, 2, groupRows[0], groupRows, 30, 20, 'split_off_amount');

  const activates = operations.filter(function(op) { return op.type === 'activate'; });
  assert.equal(activates.length, 1);
  assert.equal(activates[0].row, 3);
});

test('focusCell_ activates the requested sheet cell', () => {
  const operations = [];
  const { sandbox } = loadCode();
  const fakeSheet = {
    getRange(row, column) {
      return { activate() { operations.push({ row: row, column: column }); } };
    },
  };

  sandbox.focusCell_(fakeSheet, 9, 9);

  assert.deepEqual(JSON.parse(JSON.stringify(operations)), [{ row: 9, column: 9 }]);
});

test('performDeleteSplitRow_ merges deleted amount into previous sibling row', () => {
  const operations = [];
  const rowStore = new Map([
    [2, { resource_name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: 'Migros', narration: 'Groceries', source_account_name: 'Assets:Bank:Checking', destination_account_name: 'Expenses:Food', amount: 50, split_off_amount: '', symbol: 'CHF', status: '', last_error: '' }],
    [3, { resource_name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: 'Migros', narration: 'Groceries', source_account_name: 'Assets:Bank:Checking', destination_account_name: 'Expenses:Household', amount: 34.25, split_off_amount: '', symbol: 'CHF', status: '', last_error: '' }],
  ]);

  const { sandbox } = loadCode();
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, operations);
  fakeSheet.getActiveRange = function() {
    return { getRow() { return 3; }, getColumn() { return 9; } };
  };

  sandbox.performDeleteSplitRow_(fakeSheet, 3);

  assert.equal(rowStore.get(2).amount, 84.25);
  assert.match(JSON.stringify(operations), /deleteRow/);
});

test('performDeleteSplitRow_ resets the last destination row to source-only state', () => {
  const rowStore = new Map([
    [2, { resource_name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: 'Migros', narration: 'Groceries', source_account_name: 'Assets:Bank:Checking', destination_account_name: 'Expenses:Food', amount: 84.25, split_off_amount: '', symbol: 'CHF', status: '', last_error: '' }],
  ]);

  const { sandbox } = loadCode();
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, []);
  fakeSheet.getActiveRange = function() {
    return { getRow() { return 2; }, getColumn() { return 9; } };
  };

  sandbox.performDeleteSplitRow_(fakeSheet, 2);

  assert.equal(rowStore.get(2).destination_account_name, '');
  assert.equal(rowStore.get(2).amount, 84.25);
  assert.equal(rowStore.get(2).status, 'dirty');
});

test('performDeleteSplitRow_ focuses the merge target row when deleting the lower row', () => {
  const operations = [];
  const rowStore = new Map([
    [2, { resource_name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: 'Migros', narration: 'Groceries', source_account_name: 'Assets:Bank:Checking', destination_account_name: 'Expenses:Food', amount: 50, split_off_amount: '', symbol: 'CHF', status: '', last_error: '' }],
    [3, { resource_name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: 'Migros', narration: 'Groceries', source_account_name: 'Assets:Bank:Checking', destination_account_name: 'Expenses:Household', amount: 34.25, split_off_amount: '', symbol: 'CHF', status: '', last_error: '' }],
  ]);
  const { sandbox } = loadCode();
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, operations);
  fakeSheet.getActiveRange = function() {
    return { getRow() { return 3; }, getColumn() { return 10; } };
  };

  sandbox.performDeleteSplitRow_(fakeSheet, 3);

  const activates = operations.filter(function(op) { return op.type === 'activate'; });
  assert.equal(activates.length, 1);
  assert.equal(activates[0].row, 2);
});

test('performDeleteSplitRow_ focuses rowNumber when deleting the upper row (surviving row shifts up)', () => {
  const operations = [];
  const rowStore = new Map([
    [2, { resource_name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: 'Migros', narration: 'Groceries', source_account_name: 'Assets:Bank:Checking', destination_account_name: 'Expenses:Food', amount: 50, split_off_amount: '', symbol: 'CHF', status: '', last_error: '' }],
    [3, { resource_name: 'transactions/txn_1', transaction_date: '2026-04-19', payee: 'Migros', narration: 'Groceries', source_account_name: 'Assets:Bank:Checking', destination_account_name: 'Expenses:Household', amount: 34.25, split_off_amount: '', symbol: 'CHF', status: '', last_error: '' }],
  ]);
  const { sandbox } = loadCode();
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, operations);
  fakeSheet.getActiveRange = function() {
    return { getRow() { return 2; }, getColumn() { return 10; } };
  };

  sandbox.performDeleteSplitRow_(fakeSheet, 2);

  const activates = operations.filter(function(op) { return op.type === 'activate'; });
  assert.equal(activates.length, 1);
  assert.equal(activates[0].row, 2);
});

test('handleAmountEdit_ delegates direct increases to insertSplitRow_', () => {
  const calls = [];
  const { sandbox } = loadCode();
  const rowStore = new Map([[2, {
    resource_name: 'transactions/txn_1',
    destination_account_name: 'Expenses:Food',
    amount: 84.25,
    narration_source: 'txn',
    narration: 'Groceries',
    source_account_name: 'Assets:Bank',
    transaction_date: '2026-04-19',
    payee: '',
    split_off_amount: '',
    symbol: 'CHF',
    status: '',
    last_error: '',
  }]]);
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, []);
  sandbox.insertSplitRow_ = function(_sheet, rowNumber, _row, _groupRows, rowAmount, splitAmount) {
    calls.push({ rowNumber: rowNumber, rowAmount: rowAmount, splitAmount: splitAmount });
    return [{ __rowNumber: rowNumber }];
  };

  sandbox.handleAmountEdit_(fakeSheet, 2, '90', '84.25');

  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ rowNumber: 2, rowAmount: 90, splitAmount: -5.75 }]);
});

test('handleAmountEdit_ rejects edits for source-only transactions', () => {
  const operations = [];
  const rowStore = new Map([
    [2, { resource_name: 'transactions/txn_1', transaction_date: '2025-12-31', payee: '', narration: 'Guthabenzins: Guthabenzins', source_account_name: 'Assets:Bank:Checking', destination_account_name: '', amount: 1.5, split_off_amount: '', symbol: 'CHF', status: '', issues: '', last_error: '' }],
  ]);
  const { sandbox } = loadCode();
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, operations);

  assert.throws(() => sandbox.handleAmountEdit_(fakeSheet, 2, '1', '1.5'), /Amount cannot be edited/);
  assert.deepEqual(JSON.parse(JSON.stringify(operations)).filter((op) => op.type === 'setValue'), [
    { type: 'setValue', row: 2, column: 9, value: 1.5 },
  ]);
});

test('rollbackFailedEdit_ clears invalid split_off_amount commands', () => {
  const operations = [];
  const { sandbox } = loadCode();
  const fakeSheet = {
    getRange(row, column) {
      return { setValue(value) { operations.push({ row: row, column: column, value: value }); } };
    },
  };

  sandbox.rollbackFailedEdit_(fakeSheet, 2, 'split_off_amount', '-123');

  assert.deepEqual(JSON.parse(JSON.stringify(operations)), [{ row: 2, column: 10, value: '' }]);
});

test('handleAmountEdit_ converts a decrease into a split of the difference', () => {
  const calls = [];
  const { sandbox } = loadCode();
  const rowStore = new Map([[2, {
    resource_name: 'transactions/txn_1',
    destination_account_name: 'Expenses:Food',
    amount: 84.25,
    narration_source: 'txn',
    narration: 'Groceries',
    source_account_name: 'Assets:Bank',
    transaction_date: '2026-04-19',
    payee: '',
    split_off_amount: '',
    symbol: 'CHF',
    status: '',
    last_error: '',
  }]]);
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, []);
  sandbox.insertSplitRow_ = function(_sheet, rowNumber, _row, _groupRows, rowAmount, splitAmount) {
    calls.push({ rowNumber: rowNumber, rowAmount: rowAmount, splitAmount: splitAmount });
    return [{ __rowNumber: rowNumber }];
  };

  sandbox.handleAmountEdit_(fakeSheet, 2, '50', '84.25');

  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ rowNumber: 2, rowAmount: 50, splitAmount: 34.25 }]);
});

test('applyTransactionEdit_ treats numeric 0 as a valid new amount for amount column', () => {
  const calls = [];
  const { sandbox } = loadCode();
  sandbox.loadAccountMaps_ = function() { return { nameMap: {}, displayLookup: {} }; };
  sandbox.handleAmountEdit_ = function(_sheet, rowNumber, rawValue, oldRawValue) {
    calls.push({ rowNumber: rowNumber, rawValue: rawValue, oldRawValue: oldRawValue });
  };
  sandbox.saveTransactionByName_ = function() {};

  sandbox.applyTransactionEdit_({}, 2, 'amount', 0, '84.25', {});

  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ rowNumber: 2, rawValue: 0, oldRawValue: '84.25' }]);
});

test('performSplitInstructionForRow_ treats x and - as delete instructions', () => {
  const calls = [];
  const { sandbox } = loadCode();
  sandbox.performDeleteSplitRow_ = function(_sheet, rowNumber) {
    calls.push({ type: 'delete', rowNumber: rowNumber });
  };
  sandbox.performSplitForRow_ = function(_sheet, rowNumber, amount) {
    calls.push({ type: 'split', rowNumber: rowNumber, amount: amount });
  };

  sandbox.performSplitInstructionForRow_({}, 3, 'x');
  sandbox.performSplitInstructionForRow_({}, 4, '-');
  sandbox.performSplitInstructionForRow_({}, 5, '12.5');

  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    { type: 'delete', rowNumber: 3 },
    { type: 'delete', rowNumber: 4 },
    { type: 'split', rowNumber: 5, amount: '12.5' },
  ]);
});

test('applyTransactionEdit_ treats numeric 0 as a valid split amount for split_off_amount column', () => {
  const calls = [];
  const { sandbox } = loadCode();
  const rowStore = new Map([[5, {
    resource_name: 'transactions/txn_1',
    destination_account_name: 'Expenses:Food',
    amount: 84.25,
    narration_source: 'txn',
    narration: 'Groceries',
    source_account_name: 'Assets:Bank',
    transaction_date: '2026-04-19',
    payee: '',
    split_off_amount: '',
    symbol: 'CHF',
    status: '',
    last_error: '',
  }]]);
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, []);
  sandbox.loadAccountMaps_ = function() { return { nameMap: {}, displayLookup: {} }; };
  sandbox.performSplitInstructionForRow_ = function(_sheet, rowNumber, instruction) {
    calls.push({ rowNumber: rowNumber, instruction: instruction });
  };
  sandbox.saveTransactionByName_ = function() {};

  sandbox.applyTransactionEdit_(fakeSheet, 5, 'split_off_amount', 0, '', {});

  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ rowNumber: 5, instruction: '0' }]);
});

test('applyTransactionEdit_ edits split row narration as posting narration only', () => {
  const rowStore = new Map([
    [2, {
      resource_name: 'transactions/txn_1',
      narration_source: 'txn',
      transaction_date: '2026-04-19',
      payee: 'Migros',
      narration: 'Groceries',
      source_account_name: 'Assets:Bank:Checking',
      destination_account_name: 'Expenses:Food',
      amount: 50,
      split_off_amount: '',
      symbol: 'CHF',
      status: '',
      last_error: '',
    }],
    [3, {
      resource_name: 'transactions/txn_1',
      narration_source: 'txn',
      transaction_date: '2026-04-19',
      payee: 'Migros',
      narration: 'Groceries',
      source_account_name: 'Assets:Bank:Checking',
      destination_account_name: 'Expenses:Household',
      amount: 34.25,
      split_off_amount: '',
      symbol: 'CHF',
      status: '',
      last_error: '',
    }],
  ]);
  const { sandbox } = loadCode();
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, []);
  sandbox.loadAccountMaps_ = function() { return { nameMap: {}, displayLookup: {} }; };
  const saves = [];
  sandbox.saveTransactionByName_ = function(_sheet, precomputed) { saves.push(precomputed); };

  sandbox.applyTransactionEdit_(fakeSheet, 3, 'narration', 'Household', 'Groceries', {});

  assert.equal(rowStore.get(2).narration_source, 'txn');
  assert.equal(rowStore.get(3).narration_source, 'post');
  assert.equal(rowStore.get(3).narration, 'Household');
  assert.deepEqual(JSON.parse(JSON.stringify(saves[0].rowNumbers)), [2, 3]);
  assert.equal(saves[0].transactionName, 'transactions/txn_1');
});

test('applyTransactionEdit_ flips split row to post even when the edited value is already in the sheet row', () => {
  const rowStore = new Map([
    [2, {
      resource_name: 'transactions/txn_1',
      narration_source: 'txn',
      transaction_date: '2026-04-19',
      payee: 'Migros',
      narration: 'Groceries',
      source_account_name: 'Assets:Bank:Checking',
      destination_account_name: 'Expenses:Food',
      amount: 50,
      split_off_amount: '',
      symbol: 'CHF',
      status: '',
      last_error: '',
    }],
    [3, {
      resource_name: 'transactions/txn_1',
      narration_source: 'txn',
      transaction_date: '2026-04-19',
      payee: 'Migros',
      narration: 'Household',
      source_account_name: 'Assets:Bank:Checking',
      destination_account_name: 'Expenses:Household',
      amount: 34.25,
      split_off_amount: '',
      symbol: 'CHF',
      status: '',
      last_error: '',
    }],
  ]);
  const { sandbox } = loadCode();
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, []);
  sandbox.loadAccountMaps_ = function() { return { nameMap: {}, displayLookup: {} }; };
  sandbox.saveTransactionByName_ = function() {};

  sandbox.applyTransactionEdit_(fakeSheet, 3, 'narration', 'Household', 'Groceries', {});

  assert.equal(rowStore.get(3).narration_source, 'post');
  assert.equal(rowStore.get(3).narration, 'Household');
});

test('applyTransactionEdit_ keeps split row as txn when narration value is unchanged', () => {
  const rowStore = new Map([
    [2, {
      resource_name: 'transactions/txn_1',
      narration_source: 'txn',
      transaction_date: '2026-04-19',
      payee: 'Migros',
      narration: 'Groceries',
      source_account_name: 'Assets:Bank:Checking',
      destination_account_name: 'Expenses:Food',
      amount: 50,
      split_off_amount: '',
      symbol: 'CHF',
      status: '',
      last_error: '',
    }],
    [3, {
      resource_name: 'transactions/txn_1',
      narration_source: 'txn',
      transaction_date: '2026-04-19',
      payee: 'Migros',
      narration: 'Groceries',
      source_account_name: 'Assets:Bank:Checking',
      destination_account_name: 'Expenses:Household',
      amount: 34.25,
      split_off_amount: '',
      symbol: 'CHF',
      status: '',
      last_error: '',
    }],
  ]);
  const { sandbox } = loadCode();
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, []);
  sandbox.loadAccountMaps_ = function() { return { nameMap: {}, displayLookup: {} }; };
  sandbox.saveTransactionByName_ = function() {};

  sandbox.applyTransactionEdit_(fakeSheet, 3, 'narration', 'Groceries', 'Groceries', {});

  assert.equal(rowStore.get(3).narration_source, 'txn');
  assert.equal(rowStore.get(3).narration, 'Groceries');
});

test('applyTransactionEdit_ clears split posting narration back to transaction fallback', () => {
  const rowStore = new Map([
    [2, {
      resource_name: 'transactions/txn_1',
      narration_source: 'post',
      transaction_date: '2026-04-19',
      payee: 'Migros',
      narration: 'Produce',
      source_account_name: 'Assets:Bank:Checking',
      destination_account_name: 'Expenses:Food',
      amount: 84.25,
      split_off_amount: '',
      symbol: 'CHF',
      status: '',
      last_error: '',
    }],
    [3, {
      resource_name: 'transactions/txn_1',
      narration_source: 'txn',
      transaction_date: '2026-04-19',
      payee: 'Migros',
      narration: 'Groceries',
      source_account_name: 'Assets:Bank:Checking',
      destination_account_name: 'Expenses:Household',
      amount: 10,
      split_off_amount: '',
      symbol: 'CHF',
      status: '',
      last_error: '',
    }],
  ]);
  const { sandbox } = loadCode();
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, []);
  sandbox.loadAccountMaps_ = function() { return { nameMap: {}, displayLookup: {} }; };
  sandbox.saveTransactionByName_ = function() {};

  sandbox.applyTransactionEdit_(fakeSheet, 2, 'narration', '', 'Produce', {});

  assert.equal(rowStore.get(2).narration_source, 'txn');
  assert.equal(rowStore.get(2).narration, 'Groceries');
});

test('applyTransactionEdit_ rejects converting the last transaction narration row into posting narration', () => {
  const rowStore = new Map([
    [2, {
      resource_name: 'transactions/txn_1',
      narration_source: 'txn',
      transaction_date: '2026-04-19',
      payee: 'Migros',
      narration: 'Groceries',
      source_account_name: 'Assets:Bank:Checking',
      destination_account_name: 'Expenses:Food',
      amount: 50,
      split_off_amount: '',
      symbol: 'CHF',
      status: '',
      last_error: '',
    }],
    [3, {
      resource_name: 'transactions/txn_1',
      narration_source: 'post',
      transaction_date: '2026-04-19',
      payee: 'Migros',
      narration: 'Household',
      source_account_name: 'Assets:Bank:Checking',
      destination_account_name: 'Expenses:Household',
      amount: 34.25,
      split_off_amount: '',
      symbol: 'CHF',
      status: '',
      last_error: '',
    }],
  ]);
  const { sandbox } = loadCode();
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, []);
  sandbox.loadAccountMaps_ = function() { return { nameMap: {}, displayLookup: {} }; };

  assert.throws(
    () => sandbox.applyTransactionEdit_(fakeSheet, 2, 'narration', 'Produce', 'Groceries', {}),
    /At least one split row must keep the transaction narration/
  );
  assert.equal(rowStore.get(2).narration_source, 'txn');
  assert.equal(rowStore.get(2).narration, 'Groceries');
});

test('performSplitForRow_ does not inherit explicit posting narration onto the new row', () => {
  const rowStore = new Map([
    [2, {
      resource_name: 'transactions/txn_1',
      narration_source: 'post',
      transaction_date: '2026-04-19',
      payee: 'Migros',
      narration: 'Produce',
      source_account_name: 'Assets:Bank:Checking',
      destination_account_name: 'Expenses:Food',
      amount: 84.25,
      split_off_amount: '',
      symbol: 'CHF',
      status: '',
      last_error: '',
    }],
    [3, {
      resource_name: 'transactions/txn_1',
      narration_source: 'txn',
      transaction_date: '2026-04-19',
      payee: 'Migros',
      narration: 'Groceries',
      source_account_name: 'Assets:Bank:Checking',
      destination_account_name: 'Expenses:Household',
      amount: 10,
      split_off_amount: '',
      symbol: 'CHF',
      status: '',
      last_error: '',
    }],
  ]);
  const { sandbox } = loadCode();
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, []);
  fakeSheet.getActiveRange = function() { return { getRow() { return 3; }, getColumn() { return 10; } }; };
  sandbox.applyAccountValidationToRowNumbers_ = function() {};

  sandbox.performSplitForRow_(fakeSheet, 2, '34.25');

  assert.equal(rowStore.get(2).narration_source, 'post');
  assert.equal(rowStore.get(3).narration_source, 'txn');
  assert.equal(rowStore.get(3).narration, 'Groceries');
});

test('performDeleteSplitRow_ keeps surviving row narration ownership when removing posting narration row', () => {
  const rowStore = new Map([
    [2, {
      resource_name: 'transactions/txn_1',
      narration_source: 'txn',
      transaction_date: '2026-04-19',
      payee: 'Migros',
      narration: 'Groceries',
      source_account_name: 'Assets:Bank:Checking',
      destination_account_name: 'Expenses:Food',
      amount: 50,
      split_off_amount: '',
      symbol: 'CHF',
      status: '',
      last_error: '',
    }],
    [3, {
      resource_name: 'transactions/txn_1',
      narration_source: 'post',
      transaction_date: '2026-04-19',
      payee: 'Migros',
      narration: 'Household',
      source_account_name: 'Assets:Bank:Checking',
      destination_account_name: 'Expenses:Household',
      amount: 34.25,
      split_off_amount: '',
      symbol: 'CHF',
      status: '',
      last_error: '',
    }],
  ]);
  const { sandbox } = loadCode();
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, []);
  fakeSheet.getActiveRange = function() { return { getRow() { return 3; }, getColumn() { return 10; } }; };

  sandbox.performDeleteSplitRow_(fakeSheet, 3);

  assert.equal(rowStore.get(2).amount, 84.25);
  assert.equal(rowStore.get(2).narration_source, 'txn');
  assert.equal(rowStore.get(2).narration, 'Groceries');
});

test('performDeleteSplitRow_ normalizes surviving row back to txn when unsplitting to one row', () => {
  const rowStore = new Map([
    [2, {
      resource_name: 'transactions/txn_1',
      narration_source: 'txn',
      transaction_date: '2026-04-19',
      payee: 'Migros',
      narration: 'Groceries',
      source_account_name: 'Assets:Bank:Checking',
      destination_account_name: 'Expenses:Food',
      amount: 50,
      split_off_amount: '',
      symbol: 'CHF',
      status: '',
      last_error: '',
    }],
    [3, {
      resource_name: 'transactions/txn_1',
      narration_source: 'post',
      transaction_date: '2026-04-19',
      payee: 'Migros',
      narration: 'Household',
      source_account_name: 'Assets:Bank:Checking',
      destination_account_name: 'Expenses:Household',
      amount: 34.25,
      split_off_amount: '',
      symbol: 'CHF',
      status: '',
      last_error: '',
    }],
  ]);
  const { sandbox } = loadCode();
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, []);
  fakeSheet.getActiveRange = function() { return { getRow() { return 2; }, getColumn() { return 10; } }; };

  sandbox.performDeleteSplitRow_(fakeSheet, 2);

  assert.equal(rowStore.get(2).narration_source, 'txn');
  assert.equal(rowStore.get(2).narration, 'Household');
});

test('performSplitInstructionForRow_ rejects splits for source-only transactions', () => {
  const rowStore = new Map([
    [2, { resource_name: 'transactions/txn_1', transaction_date: '2025-12-31', payee: '', narration: 'Guthabenzins: Guthabenzins', source_account_name: 'Assets:Bank:Checking', destination_account_name: '', amount: 1.5, split_off_amount: '', symbol: 'CHF', status: '', issues: '', last_error: '' }],
  ]);
  const { sandbox } = loadCode();
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, []);

  assert.throws(() => sandbox.performSplitInstructionForRow_(fakeSheet, 2, '0.5'), /Split is unavailable/);
});
