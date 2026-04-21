const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

function loadCode(overrides = {}) {
  const properties = new Map();
  const documentProperties = new Map();
  const fetchCalls = [];
  const codePath = path.join(__dirname, '..', 'Code.js');
  const source = fs.readFileSync(codePath, 'utf8');

  const sandbox = {
    JSON,
    BigInt,
    Math,
    Date,
    String,
    Number,
    Boolean,
    Array,
    Object,
    RegExp,
    Error,
    encodeURIComponent,
    console,
    SpreadsheetApp: {
      ProtectionType: { RANGE: 'RANGE' },
      getUi() {
        throw new Error('Unexpected SpreadsheetApp.getUi() call in unit test');
      },
      newDataValidation() {
        return {
          requireValueInRange() {
            return this;
          },
          setAllowInvalid() {
            return this;
          },
          build() {
            return {};
          },
        };
      },
      ...overrides.SpreadsheetApp,
    },
    ScriptApp: {
      getProjectTriggers() {
        return [];
      },
      newTrigger() {
        return {
          forSpreadsheet() {
            return this;
          },
          onEdit() {
            return this;
          },
          create() {
            return {};
          },
        };
      },
      ...overrides.ScriptApp,
    },
    PropertiesService: {
      getScriptProperties() {
        return {
          getProperty(key) {
            return properties.has(key) ? properties.get(key) : null;
          },
          setProperty(key, value) {
            properties.set(key, value);
          },
        };
      },
      getDocumentProperties() {
        return {
          getProperty(key) {
            return documentProperties.has(key) ? documentProperties.get(key) : null;
          },
          setProperty(key, value) {
            documentProperties.set(key, value);
          },
        };
      },
      ...overrides.PropertiesService,
    },
    UrlFetchApp: {
      fetch(url, options) {
        fetchCalls.push({ url, options });
        if (overrides.fetchImpl) {
          return overrides.fetchImpl(url, options);
        }
        return {
          getResponseCode() {
            return 200;
          },
          getContentText() {
            return '{}';
          },
        };
      },
    },
    Utilities: {
      formatDate(value) {
        return value.toISOString().slice(0, 10);
      },
      ...overrides.Utilities,
    },
  };

  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'Code.js' });
  return { sandbox, properties, documentProperties, fetchCalls };
}

function sampleTransaction(overrides = {}) {
  return {
    name: 'transactions/txn_1',
    transaction_date: '2026-04-19',
    payee: 'Migros',
    narration: 'Groceries',
    postings: [
      {
        account: 'accounts/source',
        units: { amount: '-84.25', symbol: 'CHF' },
        cost: null,
        price: null,
        entity_metadata: {},
      },
      {
        account: 'accounts/food',
        units: { amount: '84.25', symbol: 'CHF' },
        cost: null,
        price: null,
        entity_metadata: {},
      },
    ],
    ...overrides,
  };
}

function makeRowStoreSheet_(sandbox, rowStore, operations) {
  function materialize(headers, row) {
    return headers.map(function(header) {
      return row[header] || '';
    });
  }

  return {
    getLastRow() {
      return Math.max.apply(null, [1].concat(Array.from(rowStore.keys())));
    },
    getRange(row, _column, numRows) {
      return {
        getValues() {
          const headers = sandbox.FAMILY_LEDGER_TRANSACTION_HEADERS || [
            'transaction_name',
            'transaction_date',
            'payee',
            'narration',
            'source_account_name',
            'destination_account_name',
            'amount',
            'split_off_amount',
            'symbol',
            'status',
            'last_error',
          ];
          const values = [];
          for (let index = 0; index < numRows; index += 1) {
            values.push(materialize(headers, rowStore.get(row + index)));
          }
          return values;
        },
        setValues(values) {
          const headers = [
            'transaction_name',
            'transaction_date',
            'payee',
            'narration',
            'source_account_name',
            'destination_account_name',
            'amount',
            'split_off_amount',
            'symbol',
            'status',
            'last_error',
          ];
          operations.push({ type: 'setValues', row: row, values: values });
          values.forEach(function(rowValues, valueIndex) {
            const rowNumber = row + valueIndex;
            const nextRow = {};
            headers.forEach(function(header, headerIndex) {
              nextRow[header] = rowValues[headerIndex];
            });
            rowStore.set(rowNumber, nextRow);
          });
        },
        setValue(value) {
          operations.push({ type: 'setValue', row: row, value: value });
        },
      };
    },
    insertRowsAfter(row, count) {
      operations.push({ type: 'insertRowsAfter', row: row, count: count });
      const keys = Array.from(rowStore.keys()).sort(function(a, b) { return b - a; });
      keys.forEach(function(current) {
        if (current > row) {
          rowStore.set(current + count, rowStore.get(current));
        }
      });
    },
    deleteRow(row) {
      operations.push({ type: 'deleteRow', row: row });
      const keys = Array.from(rowStore.keys()).sort(function(a, b) { return a - b; });
      rowStore.delete(row);
      keys.forEach(function(current) {
        if (current > row) {
          rowStore.set(current - 1, rowStore.get(current));
          rowStore.delete(current);
        }
      });
    },
  };
}

test('normalizeBaseUrl_ trims trailing slashes and rejects blank values', () => {
  const { sandbox } = loadCode();

  assert.equal(sandbox.normalizeBaseUrl_(' https://ledger.example/ '), 'https://ledger.example');
  assert.throws(() => sandbox.normalizeBaseUrl_('  '), /API base URL cannot be blank/);
});

test('normalizeApiToken_ trims values and rejects blank tokens', () => {
  const { sandbox } = loadCode();

  assert.equal(sandbox.normalizeApiToken_('  secret-token  '), 'secret-token');
  assert.throws(() => sandbox.normalizeApiToken_(''), /API token cannot be blank/);
});

test('pathWithUpdatedPageToken_ preserves query parameters and replaces page_token', () => {
  const { sandbox } = loadCode();

  assert.equal(
    sandbox.pathWithUpdatedPageToken_('/transactions?page_size=100&page_token=old&from_date=2026-01-01', 'new token'),
    '/transactions?page_size=100&from_date=2026-01-01&page_token=new%20token'
  );
});

test('decimal helpers keep exact semantics', () => {
  const { sandbox } = loadCode();

  assert.equal(sandbox.normalizeDecimalString_('0010.5000'), '10.5');
  assert.equal(sandbox.sumDecimalStrings_(['50.00', '34.25', '-4.25']), '80');
  assert.equal(sandbox.subtractDecimalStrings_('84.25', '34.25'), '50');
  assert.equal(sandbox.negateDecimalString_('84.25'), '-84.25');
  assert.equal(sandbox.compareDecimalStrings_('10', '2'), 1);
});

test('maskToken_ masks short and long tokens', () => {
  const { sandbox } = loadCode();

  assert.equal(sandbox.maskToken_('short'), '********');
  assert.equal(sandbox.maskToken_('abcdefgh12345678'), 'abcd...5678');
});

test('getRequiredFamilyLedgerApiToken_ reads script properties and fails when missing', () => {
  const { sandbox, properties } = loadCode();

  assert.throws(() => sandbox.getRequiredFamilyLedgerApiToken_(), /Missing FAMILY_LEDGER_API_TOKEN/);
  properties.set('FAMILY_LEDGER_API_TOKEN', 'secret-token');
  assert.equal(sandbox.getRequiredFamilyLedgerApiToken_(), 'secret-token');
});

test('apiFetchJson_ includes bearer auth by default and supports skipAuth', () => {
  const { sandbox, properties, fetchCalls } = loadCode();
  properties.set('FAMILY_LEDGER_BASE_URL', 'https://ledger.example');
  properties.set('FAMILY_LEDGER_API_TOKEN', 'secret-token');

  sandbox.apiFetchJson_('get', '/accounts?page_size=1');
  sandbox.apiFetchJson_('get', '/healthz', undefined, { skipAuth: true });

  assert.equal(fetchCalls[0].url, 'https://ledger.example/accounts?page_size=1');
  assert.equal(fetchCalls[0].options.headers.Authorization, 'Bearer secret-token');
  assert.equal(fetchCalls[1].url, 'https://ledger.example/healthz');
  assert.equal(fetchCalls[1].options.headers, undefined);
});

test('buildApiError_ formats structured API errors', () => {
  const { sandbox } = loadCode();

  const error = sandbox.buildApiError_(401, JSON.stringify({
    detail: {
      code: 'unauthenticated',
      message: 'Missing or invalid API token',
    },
  }));

  assert.equal(error.message, 'unauthenticated: Missing or invalid API token');
});

test('classifySupportedTransaction_ accepts simple outgoing transaction', () => {
  const { sandbox } = loadCode();

  const shape = sandbox.classifySupportedTransaction_(sampleTransaction());

  assert.deepEqual(JSON.parse(JSON.stringify(shape)), {
    sourceIndex: 0,
    destinationIndexes: [1],
    symbol: 'CHF',
  });
});

test('classifySupportedTransaction_ rejects multiple negative source legs', () => {
  const { sandbox } = loadCode();

  const shape = sandbox.classifySupportedTransaction_(sampleTransaction({
    postings: [
      {
        account: 'accounts/source-one',
        units: { amount: '-10', symbol: 'CHF' },
        cost: null,
        price: null,
      },
      {
        account: 'accounts/source-two',
        units: { amount: '-20', symbol: 'CHF' },
        cost: null,
        price: null,
      },
      {
        account: 'accounts/food',
        units: { amount: '30', symbol: 'CHF' },
        cost: null,
        price: null,
      },
    ],
  }));

  assert.equal(shape, null);
});

test('flattenTransactionForSheet_ preserves posting order for split transactions', () => {
  const { sandbox } = loadCode();

  const rows = sandbox.flattenTransactionForSheet_(sampleTransaction({
    postings: [
      {
        account: 'accounts/source',
        units: { amount: '-84.25', symbol: 'CHF' },
        cost: null,
        price: null,
      },
      {
        account: 'accounts/food',
        units: { amount: '50', symbol: 'CHF' },
        cost: null,
        price: null,
      },
      {
        account: 'accounts/household',
        units: { amount: '34.25', symbol: 'CHF' },
        cost: null,
        price: null,
      },
    ],
  }), {
    'accounts/source': 'Assets:Bank:Checking',
    'accounts/food': 'Expenses:Food',
    'accounts/household': 'Expenses:Household',
  });

  assert.equal(rows.length, 2);
  assert.equal(rows[0].destination_account_name, 'Expenses:Food');
  assert.equal(rows[1].destination_account_name, 'Expenses:Household');
  assert.equal(rows[0].split_off_amount, '');
});

test('buildTransactionPatchPayloadFromGroup_ rebuilds canonical PATCH payload in sheet row order', () => {
  const { sandbox } = loadCode();

  const payload = sandbox.buildTransactionPatchPayloadFromGroup_({
    transactionName: 'transactions/txn_1',
    contiguous: true,
    rows: [
      {
        transaction_name: 'transactions/txn_1',
        transaction_date: '2026-04-19',
        payee: 'Migros',
        narration: 'Groceries split',
        source_account_name: 'Assets:Bank:Checking',
        destination_account_name: 'Expenses:Household',
        amount: '34.25',
        symbol: 'CHF',
        __rowNumber: 4,
      },
      {
        transaction_name: 'transactions/txn_1',
        transaction_date: '2026-04-19',
        payee: 'Migros',
        narration: 'Groceries split',
        source_account_name: 'Assets:Bank:Checking',
        destination_account_name: 'Expenses:Food',
        amount: '50.00',
        symbol: 'CHF',
        __rowNumber: 5,
      },
    ],
  }, {
    'Assets:Bank:Checking': 'accounts/source',
    'Expenses:Food': 'accounts/food',
    'Expenses:Household': 'accounts/household',
  });

  assert.deepEqual(JSON.parse(JSON.stringify(payload)), {
    transaction_date: '2026-04-19',
    payee: 'Migros',
    narration: 'Groceries split',
    postings: [
      {
        account: 'accounts/source',
        units: { amount: '-84.25', symbol: 'CHF' },
      },
      {
        account: 'accounts/household',
        units: { amount: '34.25', symbol: 'CHF' },
      },
      {
        account: 'accounts/food',
        units: { amount: '50', symbol: 'CHF' },
      },
    ],
  });
});

test('buildTransactionPatchPayloadFromGroup_ normalizes Sheets date objects to yyyy-mm-dd', () => {
  const { sandbox } = loadCode();

  const payload = sandbox.buildTransactionPatchPayloadFromGroup_({
    transactionName: 'transactions/txn_1',
    contiguous: true,
    rows: [
      {
        transaction_name: 'transactions/txn_1',
        transaction_date: new Date('2019-09-15T22:00:00.000Z'),
        payee: 'Migros',
        narration: 'Groceries',
        source_account_name: 'Assets:Bank:Checking',
        destination_account_name: 'Expenses:Food',
        amount: '84.25',
        symbol: 'CHF',
        __rowNumber: 2,
      },
    ],
  }, {
    'Assets:Bank:Checking': 'accounts/source',
    'Expenses:Food': 'accounts/food',
  });

  assert.equal(payload.transaction_date, '2019-09-15');
});

test('buildTransactionPatchPayloadFromGroup_ rejects inconsistent narration', () => {
  const { sandbox } = loadCode();

  assert.throws(() => sandbox.buildTransactionPatchPayloadFromGroup_({
    transactionName: 'transactions/txn_1',
    contiguous: true,
    rows: [
      {
        transaction_name: 'transactions/txn_1',
        transaction_date: '2026-04-19',
        payee: 'Migros',
        narration: 'A',
        source_account_name: 'Assets:Bank:Checking',
        destination_account_name: 'Expenses:Food',
        amount: '50',
        symbol: 'CHF',
        __rowNumber: 2,
      },
      {
        transaction_name: 'transactions/txn_1',
        transaction_date: '2026-04-19',
        payee: 'Migros',
        narration: 'B',
        source_account_name: 'Assets:Bank:Checking',
        destination_account_name: 'Expenses:Household',
        amount: '34.25',
        symbol: 'CHF',
        __rowNumber: 3,
      },
    ],
  }, {
    'Assets:Bank:Checking': 'accounts/source',
    'Expenses:Food': 'accounts/food',
    'Expenses:Household': 'accounts/household',
  }), /Inconsistent narration/);
});

test('buildTransactionSyncSummaryMessage_ reports synced rows and skipped transactions', () => {
  const { sandbox } = loadCode();

  const message = sandbox.buildTransactionSyncSummaryMessage_(9002, 8200, 802, [
    '2019-02-15 |  | Transfer Helvetia | postings=3',
  ]);

  assert.match(message, /Fetched 9002 transactions/);
  assert.match(message, /Synced 8200 allocation rows/);
  assert.match(message, /Skipped 802 transactions/);
  assert.match(message, /Transfer Helvetia/);
});

test('describeTransactionForSyncSkip_ includes posting count and core fields', () => {
  const { sandbox } = loadCode();

  const description = sandbox.describeTransactionForSyncSkip_({
    transaction_date: '2019-02-15',
    payee: null,
    narration: 'Transfer Helvetia',
    postings: [{}, {}, {}],
  });

  assert.equal(description, '2019-02-15 |  | Transfer Helvetia | postings=3');
});

test('isContiguousRowNumbers_ identifies split and contiguous groups', () => {
  const { sandbox } = loadCode();

  assert.equal(sandbox.isContiguousRowNumbers_([2, 3, 4]), true);
  assert.equal(sandbox.isContiguousRowNumbers_([2, 4]), false);
});

test('findTransactionRowNumbersFromColumnValues_ maps transaction ids to sheet row numbers', () => {
  const { sandbox } = loadCode();

  assert.deepEqual(
    JSON.parse(JSON.stringify(sandbox.findTransactionRowNumbersFromColumnValues_([
      'transactions/a',
      'transactions/b',
      'transactions/a',
    ], 'transactions/a'))),
    [2, 4]
  );
});

test('buildContiguousRowSpans_ groups scattered row numbers into deletion spans', () => {
  const { sandbox } = loadCode();

  assert.deepEqual(
    JSON.parse(JSON.stringify(sandbox.buildContiguousRowSpans_([9, 2, 3, 7, 8]))),
    [
      { start: 2, count: 2 },
      { start: 7, count: 3 },
    ]
  );
});

test('performSplitForRow_ inserts a sibling row with duplicated destination account', () => {
  const operations = [];
  const rowStore = new Map([
    [2, {
      transaction_name: 'transactions/txn_1',
      transaction_date: '2026-04-19',
      payee: 'Migros',
      narration: 'Groceries',
      source_account_name: 'Assets:Bank:Checking',
      destination_account_name: 'Expenses:Food',
      amount: '84.25',
      split_off_amount: '20',
      symbol: 'CHF',
      status: '',
      last_error: '',
    }],
  ]);

  const { sandbox } = loadCode();
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, operations);

  sandbox.applyAccountValidationToRowNumbers_ = function(_sheet, rowNumbers) {
    operations.push({ type: 'applyValidation', rowNumbers: rowNumbers.slice() });
  };

  sandbox.performSplitForRow_(fakeSheet, 2, '20');

  assert.equal(operations[0].type, 'insertRowsAfter');
  assert.equal(operations[1].type, 'setValues');
  assert.equal(operations[2].type, 'setValues');
  assert.equal(operations[3].type, 'applyValidation');
  assert.equal(rowStore.get(2).amount, '64.25');
  assert.equal(rowStore.get(2).split_off_amount, '');
  assert.equal(rowStore.get(3).amount, '20');
  assert.equal(rowStore.get(3).destination_account_name, 'Expenses:Food');
  assert.equal(rowStore.get(3).split_off_amount, '');
});

test('performDeleteSplitRow_ merges deleted amount into previous sibling row', () => {
  const operations = [];
  const rowStore = new Map([
    [2, {
      transaction_name: 'transactions/txn_1',
      transaction_date: '2026-04-19',
      payee: 'Migros',
      narration: 'Groceries',
      source_account_name: 'Assets:Bank:Checking',
      destination_account_name: 'Expenses:Food',
      amount: '50',
      split_off_amount: '',
      symbol: 'CHF',
      status: '',
      last_error: '',
    }],
    [3, {
      transaction_name: 'transactions/txn_1',
      transaction_date: '2026-04-19',
      payee: 'Migros',
      narration: 'Groceries',
      source_account_name: 'Assets:Bank:Checking',
      destination_account_name: 'Expenses:Household',
      amount: '34.25',
      split_off_amount: '',
      symbol: 'CHF',
      status: '',
      last_error: '',
    }],
  ]);

  const { sandbox } = loadCode();
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, operations);

  sandbox.performDeleteSplitRow_(fakeSheet, 3);

  assert.equal(rowStore.get(2).amount, '84.25');
  assert.match(JSON.stringify(operations), /deleteRow/);
});

test('performDeleteSplitRow_ rejects deleting the only allocation row', () => {
  const rowStore = new Map([
    [2, {
      transaction_name: 'transactions/txn_1',
      transaction_date: '2026-04-19',
      payee: 'Migros',
      narration: 'Groceries',
      source_account_name: 'Assets:Bank:Checking',
      destination_account_name: 'Expenses:Food',
      amount: '84.25',
      split_off_amount: '',
      symbol: 'CHF',
      status: '',
      last_error: '',
    }],
  ]);

  const { sandbox } = loadCode();
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, []);

  assert.throws(() => sandbox.performDeleteSplitRow_(fakeSheet, 2), /Cannot delete the only allocation row/);
});

test('handleAmountEdit_ rejects direct increases and restores previous amount', () => {
  const operations = [];
  const { sandbox } = loadCode();
  const fakeSheet = {
    getRange(row, column) {
      return {
        setValue(value) {
          operations.push({ row: row, column: column, value: value });
        },
      };
    },
  };

  assert.throws(() => sandbox.handleAmountEdit_(fakeSheet, 2, '90', '84.25'), /Imported transaction totals are fixed/);
  assert.deepEqual(JSON.parse(JSON.stringify(operations)), [
    { row: 2, column: 7, value: '84.25' },
  ]);
});

test('handleAmountEdit_ converts a decrease into a split of the difference', () => {
  const calls = [];
  const { sandbox } = loadCode();
  sandbox.performSplitFromEditedAmount_ = function(_sheet, rowNumber, oldAmount, newAmount) {
    calls.push({ rowNumber: rowNumber, oldAmount: oldAmount, newAmount: newAmount });
  };

  sandbox.handleAmountEdit_({}, 2, '50', '84.25');

  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    { rowNumber: 2, oldAmount: '84.25', newAmount: '50' },
  ]);
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

test('canUpdateTransactionRowsInPlace_ accepts same-shape replacement rows', () => {
  const { sandbox } = loadCode();

  assert.equal(
    sandbox.canUpdateTransactionRowsInPlace_(
      [
        {
          transaction_name: 'transactions/txn_1',
          source_account_name: 'Assets:Bank:Checking',
          symbol: 'CHF',
        },
      ],
      [
        {
          transaction_name: 'transactions/txn_1',
          source_account_name: 'Assets:Bank:Checking',
          symbol: 'CHF',
        },
      ]
    ),
    true
  );
});

test('canUpdateTransactionRowsInPlace_ rejects row count changes', () => {
  const { sandbox } = loadCode();

  assert.equal(
    sandbox.canUpdateTransactionRowsInPlace_(
      [
        {
          transaction_name: 'transactions/txn_1',
          source_account_name: 'Assets:Bank:Checking',
          symbol: 'CHF',
        },
      ],
      [
        {
          transaction_name: 'transactions/txn_1',
          source_account_name: 'Assets:Bank:Checking',
          symbol: 'CHF',
        },
        {
          transaction_name: 'transactions/txn_1',
          source_account_name: 'Assets:Bank:Checking',
          symbol: 'CHF',
        },
      ]
    ),
    false
  );
});

test('updateTransactionRowsInPlace_ writes only changed cells', () => {
  const operations = [];
  const { sandbox } = loadCode();
  const fakeSheet = {
    getRange(row, column) {
      return {
        setValue(value) {
          operations.push({ row: row, column: column, value: value });
        },
      };
    },
  };

  sandbox.updateTransactionRowsInPlace_(
    fakeSheet,
    [2],
    [
      {
        transaction_name: 'transactions/txn_1',
        transaction_date: '2026-04-19',
        payee: 'Old',
        narration: 'Keep',
        source_account_name: 'Assets:Bank:Checking',
        destination_account_name: 'Expenses:Food',
        amount: '84.25',
        split_off_amount: '',
        symbol: 'CHF',
        status: 'saving',
        last_error: '',
      },
    ],
    [
      {
        transaction_name: 'transactions/txn_1',
        transaction_date: '2026-04-19',
        payee: 'New',
        narration: 'Keep',
        source_account_name: 'Assets:Bank:Checking',
        destination_account_name: 'Expenses:Food',
        amount: '84.25',
        split_off_amount: '',
        symbol: 'CHF',
        status: 'saved',
        last_error: '',
      },
    ]
  );

  assert.deepEqual(JSON.parse(JSON.stringify(operations)), [
    { row: 2, column: 3, value: 'New' },
    { row: 2, column: 10, value: 'saved' },
  ]);
});

test('save generation helpers ignore stale responses', () => {
  const { sandbox, documentProperties } = loadCode();

  const first = sandbox.beginSaveGeneration_('transactions/txn_1');
  const second = sandbox.beginSaveGeneration_('transactions/txn_1');

  assert.equal(first, '1');
  assert.equal(second, '2');
  assert.equal(documentProperties.get('family_ledger_save_generation:transactions/txn_1'), '2');
  assert.equal(sandbox.isCurrentSaveGeneration_('transactions/txn_1', '1'), false);
  assert.equal(sandbox.isCurrentSaveGeneration_('transactions/txn_1', '2'), true);
});
