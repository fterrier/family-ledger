const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const CLIENT_DIR = path.join(__dirname, '..');

// Files loaded in dependency order: constants first, then helpers, then Code.js.
const SOURCE_FILES = [
  'Constants.js',
  'Decimal.js',
  'ApiClient.js',
  'Utils.js',
  'Accounts.js',
  'SheetIO.js',
  'Layout.js',
  'Doctor.js',
  'Code.js',
];

function loadCode(overrides = {}) {
  const properties = new Map();
  const documentProperties = new Map();
  const fetchCalls = [];
  const source = SOURCE_FILES
    .map((name) => fs.readFileSync(path.join(CLIENT_DIR, name), 'utf8'))
    .join('\n');

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
      BooleanCriteria: { CUSTOM_FORMULA: 'CUSTOM_FORMULA' },
      getUi() {
        throw new Error('Unexpected SpreadsheetApp.getUi() call in unit test');
      },
      newRichTextValue() {
        return {
          text: '',
          style: null,
          setText(value) {
            this.text = value;
            return this;
          },
          setTextStyle(_start, _end, style) {
            this.style = style;
            return this;
          },
          build() {
            return { text: this.text, style: this.style };
          },
        };
      },
      newTextStyle() {
        return {
          bold: false,
          setBold(value) {
            this.bold = value;
            return this;
          },
          build() {
            return { bold: this.bold };
          },
        };
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
      newConditionalFormatRule() {
        const rule = {
          formula: '',
          background: '',
          ranges: [],
          whenFormulaSatisfied(value) {
            this.formula = value;
            return this;
          },
          setBackground(value) {
            this.background = value;
            return this;
          },
          setRanges(value) {
            this.ranges = value;
            return this;
          },
          build() {
            return {
              getBooleanCondition() {
                return {
                  getCriteriaType() {
                    return 'CUSTOM_FORMULA';
                  },
                  getCriteriaValues() {
                    return [rule.formula];
                  },
                };
              },
              formula: rule.formula,
              background: rule.background,
              ranges: rule.ranges,
            };
          },
        };
        return rule;
      },
      newFilterCriteria() {
        let _formula = null;
        return {
          whenFormulaSatisfied(f) { _formula = f; return this; },
          build() { return { formula: _formula }; },
        };
      },
      getActiveSpreadsheet() {
        return {
          getSheetByName(name) {
            return (overrides.sheetsByName || {})[name] || null;
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
          deleteProperty(key) {
            documentProperties.delete(key);
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
      sleep(_ms) {},
      ...overrides.Utilities,
    },
  };

  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'family-ledger-sheets' });
  return { sandbox, properties, documentProperties, fetchCalls };
}

function sampleTransaction(overrides = {}) {
  return {
    name: 'transactions/txn_1',
    transaction_date: '2026-04-19',
    payee: 'Migros',
    narration: 'Groceries',
    issues: [],
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
  const conditionalFormatRules = [];
  let hidden = false;

  function materialize(headers, row) {
    return headers.map(function(header) {
      return row[header] || '';
    });
  }

  return {
    getLastRow() {
      return Math.max.apply(null, [1].concat(Array.from(rowStore.keys())));
    },
    clearContents() {
      operations.push({ type: 'clearContents' });
      rowStore.clear();
    },
    clearFormats() {
      operations.push({ type: 'clearFormats' });
    },
    getMaxRows() {
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
            'symbol',
            'amount',
            'split_off_amount',
            'status',
            'last_error',
            'issues',
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
            'symbol',
            'amount',
            'split_off_amount',
            'status',
            'last_error',
            'issues',
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
          const headers = [
            'transaction_name',
            'transaction_date',
            'payee',
            'narration',
            'source_account_name',
            'destination_account_name',
            'symbol',
            'amount',
            'split_off_amount',
            'status',
            'last_error',
            'issues',
          ];
          const currentRow = rowStore.get(row) || {};
          currentRow[headers[_column - 1]] = value;
          rowStore.set(row, currentRow);
        },
        setFormulas(values) {
          operations.push({ type: 'setFormulas', row: row, column: _column, values: values });
          const headers = [
            'transaction_name',
            'transaction_date',
            'payee',
            'narration',
            'source_account_name',
            'destination_account_name',
            'symbol',
            'amount',
            'split_off_amount',
            'status',
            'last_error',
            'issues',
          ];
          values.forEach(function(rowValues, valueIndex) {
            const rowNumber = row + valueIndex;
            const currentRow = rowStore.get(rowNumber) || {};
            currentRow[headers[_column - 1]] = rowValues[0];
            rowStore.set(rowNumber, currentRow);
          });
        },
        setBackground(value) {
          operations.push({ type: 'setBackground', row: row, column: _column, value: value });
        },
        setBackgrounds(values) {
          operations.push({ type: 'setBackgrounds', row: row, column: _column, values: values });
        },
        activate() {
          operations.push({ type: 'activate', row: row, column: _column });
        },
        createFilter() {
          operations.push({ type: 'createFilter', row: row, numRows: numRows });
          return { setColumnFilterCriteria() {} };
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
    getConditionalFormatRules() {
      return conditionalFormatRules.slice();
    },
    setConditionalFormatRules(rules) {
      operations.push({ type: 'setConditionalFormatRules', rules: rules });
      conditionalFormatRules.length = 0;
      rules.forEach(function(rule) {
        conditionalFormatRules.push(rule);
      });
    },
    hideSheet() {
      hidden = true;
      operations.push({ type: 'hideSheet' });
    },
    isSheetHidden() {
      return hidden;
    },
    getFilter() {
      return null;
    },
  };
}

test('no duplicate const/let declarations across source files', () => {
  const identifierPattern = /^(?:const|let)\s+([A-Za-z_$][A-Za-z0-9_$]*)/;
  const seen = new Map(); // identifier -> filename
  SOURCE_FILES.forEach((name) => {
    const lines = fs.readFileSync(path.join(CLIENT_DIR, name), 'utf8').split('\n');
    lines.forEach((line) => {
      const match = line.match(identifierPattern);
      if (!match) return;
      const identifier = match[1];
      assert.ok(
        !seen.has(identifier),
        `'${identifier}' declared in both '${seen.get(identifier)}' and '${name}'`
      );
      seen.set(identifier, name);
    });
  });
});

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


test('maskToken_ masks short and long tokens', () => {
  const { sandbox } = loadCode();

  assert.equal(sandbox.maskToken_('short'), '********');
  assert.equal(sandbox.maskToken_('abcdefgh12345678'), 'abcd...5678');
});

test('debugLog_ is silent when FAMILY_LEDGER_DEBUG_LOGS is not enabled', () => {
  const { sandbox } = loadCode();
  const messages = [];

  sandbox.console = {
    log(message) {
      messages.push(message);
    },
  };

  sandbox.debugLog_('event', { ok: true });

  assert.deepEqual(messages, []);
});

test('debugLog_ logs structured messages when FAMILY_LEDGER_DEBUG_LOGS is enabled', () => {
  const { sandbox, properties } = loadCode();
  const messages = [];

  properties.set('FAMILY_LEDGER_DEBUG_LOGS', 'true');
  sandbox.console = {
    log(message) {
      messages.push(message);
    },
  };

  sandbox.debugLog_('event', { ok: true, transactionName: 'transactions/txn_1' });

  assert.equal(messages.length, 1);
  assert.equal(
    messages[0],
    '[family-ledger] event {"ok":true,"transactionName":"transactions/txn_1"}'
  );
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

test('isBandwidthQuotaError_ recognizes bandwidth quota exceptions', () => {
  const { sandbox } = loadCode();

  assert.equal(sandbox.isBandwidthQuotaError_(new Error('Bandwidth quota exceeded: https://example.com')), true);
  assert.equal(sandbox.isBandwidthQuotaError_(new Error('Some other error')), false);
  assert.equal(sandbox.isBandwidthQuotaError_(null), false);
});

test('apiFetchJson_ retries on bandwidth quota errors and succeeds', () => {
  let attempts = 0;
  const sleepCalls = [];
  const { sandbox, properties } = loadCode({
    fetchImpl() {
      attempts++;
      if (attempts < 3) {
        throw new Error('Bandwidth quota exceeded: https://ledger.example/test');
      }
      return { getResponseCode() { return 200; }, getContentText() { return '{}'; } };
    },
    Utilities: { sleep(ms) { sleepCalls.push(ms); } },
  });

  properties.set('FAMILY_LEDGER_BASE_URL', 'https://ledger.example');
  properties.set('FAMILY_LEDGER_API_TOKEN', 'secret');

  const result = sandbox.apiFetchJson_('get', '/test');
  assert.equal(attempts, 3);
  assert.equal(sleepCalls.length, 2);
  assert.deepEqual(result, {});
});

test('apiFetchJson_ re-throws after max retries exceeded', () => {
  let attempts = 0;
  const { sandbox, properties } = loadCode({
    fetchImpl() {
      attempts++;
      throw new Error('Bandwidth quota exceeded: https://ledger.example/test');
    },
    Utilities: { sleep(_ms) {} },
  });

  properties.set('FAMILY_LEDGER_BASE_URL', 'https://ledger.example');
  properties.set('FAMILY_LEDGER_API_TOKEN', 'secret');

  assert.throws(() => sandbox.apiFetchJson_('get', '/test'), /Bandwidth quota exceeded/);
  assert.equal(attempts, 4); // initial attempt + 3 retries
});

test('buildApiError_ formats structured API errors', () => {
  const { sandbox } = loadCode();

  const error = sandbox.buildApiError_(401, JSON.stringify({
    detail: {
      code: 'unauthenticated',
      message: 'Missing or invalid API token',
    },
  }));

  assert.equal(error.message, '401 unauthenticated: Missing or invalid API token');
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

test('classifySupportedTransaction_ accepts zero postings', () => {
  const { sandbox } = loadCode();

  const shape = sandbox.classifySupportedTransaction_({ postings: [] });

  assert.deepEqual(JSON.parse(JSON.stringify(shape)), {
    sourceIndex: null,
    destinationIndexes: [],
    symbol: null,
  });
});

test('classifySupportedTransaction_ uses balance-sheet account as source for income transaction', () => {
  const { sandbox } = loadCode();

  const shape = sandbox.classifySupportedTransaction_({
    postings: [
      { account: 'accounts/salary', units: { amount: '-5000', symbol: 'CHF' }, cost: null, price: null },
      { account: 'accounts/bank', units: { amount: '5000', symbol: 'CHF' }, cost: null, price: null },
    ],
  }, {
    'accounts/salary': '[I] Salary',
    'accounts/bank': '[A] Bank',
  });

  assert.deepEqual(JSON.parse(JSON.stringify(shape)), {
    sourceIndex: 1,
    destinationIndexes: [0],
    symbol: 'CHF',
  });
});

test('classifySupportedTransaction_ accepts single positive balance-sheet posting', () => {
  const { sandbox } = loadCode();

  const shape = sandbox.classifySupportedTransaction_({
    postings: [
      { account: 'accounts/savings', units: { amount: '5524.65', symbol: 'CHF' }, cost: null, price: null },
    ],
  }, {
    'accounts/savings': '[A] Savings',
  });

  assert.deepEqual(JSON.parse(JSON.stringify(shape)), {
    sourceIndex: 0,
    destinationIndexes: [],
    symbol: 'CHF',
  });
});

test('classifySupportedTransaction_ prefers negative balance-sheet account as source for transfers', () => {
  const { sandbox } = loadCode();

  const shape = sandbox.classifySupportedTransaction_({
    postings: [
      { account: 'accounts/checking', units: { amount: '-100', symbol: 'CHF' }, cost: null, price: null },
      { account: 'accounts/savings', units: { amount: '100', symbol: 'CHF' }, cost: null, price: null },
    ],
  }, {
    'accounts/checking': '[A] Checking',
    'accounts/savings': '[A] Savings',
  });

  assert.deepEqual(JSON.parse(JSON.stringify(shape)), {
    sourceIndex: 0,
    destinationIndexes: [1],
    symbol: 'CHF',
  });
});

test('classifySupportedTransaction_ rejects two positive postings with no balance-sheet account', () => {
  const { sandbox } = loadCode();

  const shape = sandbox.classifySupportedTransaction_({
    postings: [
      { account: 'accounts/food', units: { amount: '50', symbol: 'CHF' }, cost: null, price: null },
      { account: 'accounts/household', units: { amount: '50', symbol: 'CHF' }, cost: null, price: null },
    ],
  }, {
    'accounts/food': '[X] Food',
    'accounts/household': '[X] Household',
  });

  assert.equal(shape, null);
});

test('formatAccountDisplayName_ shortens canonical account names with root markers', () => {
  const { sandbox } = loadCode();

  assert.equal(
    sandbox.formatAccountDisplayName_('Assets:Bank:Checking:Family'),
    '[A] Bank - Checking - Family'
  );
  assert.equal(
    sandbox.formatAccountDisplayName_('Expenses:Food:Groceries'),
    '[X] Food - Groceries'
  );
});

test('buildAccountDisplayEntries_ produces display labels for account resources', () => {
  const { sandbox } = loadCode();

  assert.deepEqual(
    JSON.parse(JSON.stringify(sandbox.buildAccountDisplayEntries_([
      {
        name: 'accounts/acc_1',
        account_name: 'Assets:Bank:Checking:Family',
      },
      {
        name: 'accounts/acc_2',
        account_name: 'Expenses:Food',
      },
    ]))),
    [
      {
        name: 'accounts/acc_1',
        account_name: 'Assets:Bank:Checking:Family',
        display_name: '[A] Bank - Checking - Family',
      },
      {
        name: 'accounts/acc_2',
        account_name: 'Expenses:Food',
        display_name: '[X] Food',
      },
    ]
  );
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

test('classifySupportedTransaction_ accepts source-only transaction', () => {
  const { sandbox } = loadCode();

  const shape = sandbox.classifySupportedTransaction_({
    postings: [
      {
        account: 'accounts/source',
        units: { amount: '-1.5', symbol: 'CHF' },
        cost: null,
        price: null,
      },
    ],
  });

  assert.deepEqual(JSON.parse(JSON.stringify(shape)), {
    sourceIndex: 0,
    destinationIndexes: [],
    symbol: 'CHF',
  });
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

test('mergeDoctorIssuesIntoRows_ merges doctor issues onto every transaction row', () => {
  const { sandbox } = loadCode();

  const rows = sandbox.flattenTransactionForSheet_(sampleTransaction(), {
    'accounts/source': 'Assets:Bank:Checking',
    'accounts/food': 'Expenses:Food',
  });

  sandbox.mergeDoctorIssuesIntoRows_(rows, {
    'transactions/txn_1': [
      {
        target: 'transactions/txn_1',
        code: 'transaction_unbalanced',
        message: 'Transaction is not balanced within tolerance.',
        details: {
          symbol: 'CHF',
          residual_amount: '-4.25',
          tolerance_amount: '0.005',
        },
      },
    ],
  });

  assert.equal(rows[0].issues, 'transaction_unbalanced (CHF, residual -4.25, tolerance 0.005)');
});

test('applyFetchedDoctorIssuesToExistingSheet_ clears stale issues and reapplies row highlighting', () => {
  const operations = [];
  const rowStore = new Map([
    [2, {
      transaction_name: 'transactions/txn_1',
      transaction_date: '2026-04-19',
      payee: 'Migros',
      narration: 'Groceries',
      source_account_name: 'Assets:Bank:Checking',
      destination_account_name: 'Expenses:Food',
      amount: 84.25,
      split_off_amount: '',
      symbol: 'CHF',
      status: 'saved',
      issues: 'transaction_unbalanced (CHF, residual -4.25, tolerance 0.005)',
      last_error: '',
    }],
  ]);
  const { sandbox } = loadCode();
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, operations);

  sandbox.applyFetchedDoctorIssuesToExistingSheet_(fakeSheet, {});

  assert.equal(rowStore.get(2).issues, '');
});

test('flattenTransactionForSheet_ renders source-only transactions as one blank-destination row', () => {
  const { sandbox } = loadCode();

  const rows = sandbox.flattenTransactionForSheet_({
    name: 'transactions/txn_1',
    transaction_date: '2025-12-31',
    payee: null,
    narration: 'Guthabenzins: Guthabenzins',
    postings: [
      {
        account: 'accounts/source',
        units: { amount: '-1.5', symbol: 'CHF' },
        cost: null,
        price: null,
      },
    ],
  }, {
    'accounts/source': 'Assets:Bank:Checking',
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].destination_account_name, '');
  assert.equal(rows[0].amount, 1.5);
});

test('flattenTransactionForSheet_ renders zero-posting transactions as a placeholder row', () => {
  const { sandbox } = loadCode();

  const rows = sandbox.flattenTransactionForSheet_({
    name: 'transactions/txn_empty',
    transaction_date: '2025-01-01',
    payee: '',
    narration: 'No postings yet',
    postings: [],
  }, {});

  assert.equal(rows.length, 1);
  assert.equal(rows[0].source_account_name, '');
  assert.equal(rows[0].destination_account_name, '');
  assert.equal(rows[0].amount, '');
  assert.equal(rows[0].symbol, '');
});

test('flattenTransactionForSheet_ uses balance-sheet account as source with negative destination for income', () => {
  const { sandbox } = loadCode();

  const rows = sandbox.flattenTransactionForSheet_({
    name: 'transactions/txn_1',
    transaction_date: '2026-01-31',
    payee: '',
    narration: 'Monthly salary',
    postings: [
      { account: 'accounts/salary', units: { amount: '-5000', symbol: 'CHF' }, cost: null, price: null },
      { account: 'accounts/bank', units: { amount: '5000', symbol: 'CHF' }, cost: null, price: null },
    ],
  }, {
    'accounts/salary': '[I] Salary',
    'accounts/bank': '[A] Bank',
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].source_account_name, '[A] Bank');
  assert.equal(rows[0].destination_account_name, '[I] Salary');
  assert.equal(rows[0].amount, -5000);
  assert.equal(rows[0].symbol, 'CHF');
});

test('flattenTransactionForSheet_ shows abs amount for source-only with positive balance-sheet posting', () => {
  const { sandbox } = loadCode();

  const rows = sandbox.flattenTransactionForSheet_({
    name: 'transactions/txn_1',
    transaction_date: '2025-03-18',
    payee: '',
    narration: 'Incomplete transfer',
    postings: [
      { account: 'accounts/savings', units: { amount: '5524.65', symbol: 'CHF' }, cost: null, price: null },
    ],
  }, {
    'accounts/savings': '[A] Savings',
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].source_account_name, '[A] Savings');
  assert.equal(rows[0].destination_account_name, '');
  assert.equal(rows[0].amount, 5524.65);
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
        amount: 34.25,
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
        amount: 50,
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
        amount: 84.25,
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
        amount: 50,
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
        amount: 34.25,
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

test('buildTransactionPatchPayloadFromGroup_ emits source-only transaction when destination is blank', () => {
  const { sandbox } = loadCode();

  const payload = sandbox.buildTransactionPatchPayloadFromGroup_({
    transactionName: 'transactions/txn_1',
    contiguous: true,
    rows: [
      {
        transaction_name: 'transactions/txn_1',
        transaction_date: '2025-12-31',
        payee: '',
        narration: 'Guthabenzins: Guthabenzins',
        source_account_name: 'Assets:Bank:Checking',
        destination_account_name: '',
        amount: 1.5,
        symbol: 'CHF',
        __rowNumber: 2,
      },
    ],
  }, {
    'Assets:Bank:Checking': 'accounts/source',
  });

  assert.deepEqual(JSON.parse(JSON.stringify(payload)), {
    transaction_date: '2025-12-31',
    payee: null,
    narration: 'Guthabenzins: Guthabenzins',
    postings: [
      {
        account: 'accounts/source',
        units: { amount: '-1.5', symbol: 'CHF' },
      },
    ],
  });
});

test('buildTransactionPatchPayloadFromGroup_ rejects mixed blank and non-blank destinations', () => {
  const { sandbox } = loadCode();

  assert.throws(() => sandbox.buildTransactionPatchPayloadFromGroup_({
    transactionName: 'transactions/txn_1',
    contiguous: true,
    rows: [
      {
        transaction_name: 'transactions/txn_1',
        transaction_date: '2026-04-19',
        payee: 'Migros',
        narration: 'Groceries',
        source_account_name: 'Assets:Bank:Checking',
        destination_account_name: '',
        amount: 50,
        symbol: 'CHF',
        __rowNumber: 2,
      },
      {
        transaction_name: 'transactions/txn_1',
        transaction_date: '2026-04-19',
        payee: 'Migros',
        narration: 'Groceries',
        source_account_name: 'Assets:Bank:Checking',
        destination_account_name: 'Expenses:Food',
        amount: 34.25,
        symbol: 'CHF',
        __rowNumber: 3,
      },
    ],
  }, {
    'Assets:Bank:Checking': 'accounts/source',
    'Expenses:Food': 'accounts/food',
  }), /must either all have destination accounts or all leave destination_account_name blank/);
});

test('buildTransactionPatchPayloadFromGroup_ accepts negative destination amounts for income rows', () => {
  const { sandbox } = loadCode();

  const payload = sandbox.buildTransactionPatchPayloadFromGroup_({
    transactionName: 'transactions/txn_income',
    contiguous: true,
    rows: [
      {
        transaction_name: 'transactions/txn_income',
        transaction_date: '2026-01-31',
        payee: '',
        narration: 'Monthly salary',
        source_account_name: '[A] Bank',
        destination_account_name: '[I] Salary',
        amount: -5000,
        symbol: 'CHF',
        __rowNumber: 2,
      },
    ],
  }, {
    '[A] Bank': 'accounts/bank',
    '[I] Salary': 'accounts/salary',
  });

  assert.deepEqual(JSON.parse(JSON.stringify(payload)), {
    transaction_date: '2026-01-31',
    payee: null,
    narration: 'Monthly salary',
    postings: [
      { account: 'accounts/bank', units: { amount: '5000', symbol: 'CHF' } },
      { account: 'accounts/salary', units: { amount: '-5000', symbol: 'CHF' } },
    ],
  });
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
      amount: 84.25,
      split_off_amount: '20',
      symbol: 'CHF',
      status: '',
      last_error: '',
    }],
  ]);

  const { sandbox } = loadCode();
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, operations);
  fakeSheet.getActiveRange = function() {
    return {
      getRow() {
        return 3;
      },
      getColumn() {
        return 9;
      },
    };
  };
  fakeSheet.getRange = function(row, column, numRows) {
    if (numRows === undefined) {
      return {
        activate() {
          operations.push({ type: 'activate', row: row, column: column });
        },
      };
    }
    return makeRowStoreSheet_(sandbox, rowStore, operations).getRange(row, column, numRows);
  };

  sandbox.applyAccountValidationToRowNumbers_ = function(_sheet, rowNumbers) {
    operations.push({ type: 'applyValidation', rowNumbers: rowNumbers.slice() });
  };

  sandbox.performSplitForRow_(fakeSheet, 2, '20');

  assert.equal(operations[0].type, 'insertRowsAfter');
  assert.equal(operations[1].type, 'setValues');
  assert.equal(operations[2].type, 'setValues');
  assert.equal(operations[3].type, 'applyValidation');
  assert.equal(operations[4].type, 'activate');
  assert.equal(operations[4].row, 3);
  assert.equal(operations[4].column, 9);
  assert.equal(rowStore.get(2).amount, 64.25);
  assert.equal(rowStore.get(2).split_off_amount, '');
  assert.equal(rowStore.get(3).amount, 20);
  assert.equal(rowStore.get(3).destination_account_name, 'Expenses:Food');
  assert.equal(rowStore.get(3).split_off_amount, '');
});

test('performSplitForRow_ splits a negative-amount row using a positive split amount', () => {
  const operations = [];
  const rowStore = new Map([
    [2, {
      transaction_name: 'transactions/txn_income',
      transaction_date: '2026-01-31',
      payee: '',
      narration: 'Monthly salary',
      source_account_name: '[A] Bank',
      destination_account_name: '[I] Salary',
      amount: -5000,
      split_off_amount: '2000',
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
  fakeSheet.getRange = function(row, column, numRows) {
    if (numRows === undefined) {
      return { activate() { operations.push({ type: 'activate', row: row, column: column }); } };
    }
    return makeRowStoreSheet_(sandbox, rowStore, operations).getRange(row, column, numRows);
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
      transaction_name: 'transactions/txn_1',
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
  fakeSheet.getRange = function(row, column, numRows) {
    if (numRows === undefined) {
      return { activate() { operations.push({ type: 'activate', row: row, column: column }); } };
    }
    return makeRowStoreSheet_(sandbox, rowStore, operations).getRange(row, column, numRows);
  };
  sandbox.applyAccountValidationToRowNumbers_ = function() {};

  sandbox.performSplitForRow_(fakeSheet, 2, '0');

  assert.equal(rowStore.get(2).amount, 84.25);
  assert.equal(rowStore.get(3).amount, 0);
});

test('focusPostEnterAfterInsert_ moves focus to the next row in the edited column', () => {
  const { sandbox } = loadCode();
  const operations = [];
  const fakeSheet = {
    getLastRow() {
      return 20;
    },
    getRange(row, column) {
      return {
        activate() {
          operations.push({ row: row, column: column });
        },
      };
    },
  };

  sandbox.focusPostEnterAfterInsert_(fakeSheet, 12, 5);

  assert.deepEqual(JSON.parse(JSON.stringify(operations)), [{ row: 13, column: 5 }]);
});

test('focusPostEnterAfterInsert_ clamps to the last row when needed', () => {
  const { sandbox } = loadCode();
  const operations = [];
  const fakeSheet = {
    getLastRow() {
      return 10;
    },
    getRange(row, column) {
      return {
        activate() {
          operations.push({ row: row, column: column });
        },
      };
    },
  };

  sandbox.focusPostEnterAfterInsert_(fakeSheet, 10, 5);

  assert.deepEqual(JSON.parse(JSON.stringify(operations)), [{ row: 10, column: 5 }]);
});

test('focusPostEnterAfterDelete_ keeps focus on the edited row in the edited column', () => {
  const { sandbox } = loadCode();
  const operations = [];
  const fakeSheet = {
    getLastRow() {
      return 20;
    },
    getRange(row, column) {
      return {
        activate() {
          operations.push({ row: row, column: column });
        },
      };
    },
  };

  sandbox.focusPostEnterAfterDelete_(fakeSheet, 12, 5);

  assert.deepEqual(JSON.parse(JSON.stringify(operations)), [{ row: 12, column: 5 }]);
});

test('focusPostEnterAfterDelete_ clamps to the last row when needed', () => {
  const { sandbox } = loadCode();
  const operations = [];
  const fakeSheet = {
    getLastRow() {
      return 10;
    },
    getRange(row, column) {
      return {
        activate() {
          operations.push({ row: row, column: column });
        },
      };
    },
  };

  sandbox.focusPostEnterAfterDelete_(fakeSheet, 12, 5);

  assert.deepEqual(JSON.parse(JSON.stringify(operations)), [{ row: 10, column: 5 }]);
});

test('focusCell_ activates the requested sheet cell', () => {
  const operations = [];
  const { sandbox } = loadCode();
  const fakeSheet = {
    getRange(row, column) {
      return {
        activate() {
          operations.push({ row: row, column: column });
        },
      };
    },
  };

  sandbox.focusCell_(fakeSheet, 9, 9);

  assert.deepEqual(JSON.parse(JSON.stringify(operations)), [{ row: 9, column: 9 }]);
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
      amount: 50,
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
      amount: 34.25,
      split_off_amount: '',
      symbol: 'CHF',
      status: '',
      last_error: '',
    }],
  ]);

  const { sandbox } = loadCode();
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, operations);
  fakeSheet.getActiveRange = function() {
    return {
      getRow() {
        return 3;
      },
      getColumn() {
        return 9;
      },
    };
  };

  sandbox.performDeleteSplitRow_(fakeSheet, 3);

  assert.equal(rowStore.get(2).amount, 84.25);
  assert.match(JSON.stringify(operations), /deleteRow/);
});

test('performDeleteSplitRow_ resets the last destination row to source-only state', () => {
  const rowStore = new Map([
    [2, {
      transaction_name: 'transactions/txn_1',
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
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, []);
  fakeSheet.getActiveRange = function() {
    return {
      getRow() {
        return 2;
      },
      getColumn() {
        return 9;
      },
    };
  };

  sandbox.performDeleteSplitRow_(fakeSheet, 2);

  assert.equal(rowStore.get(2).destination_account_name, '');
  assert.equal(rowStore.get(2).amount, 84.25);
  assert.equal(rowStore.get(2).status, 'dirty');
});

test('handleAmountEdit_ delegates direct increases to performSplitFromEditedAmount_', () => {
  const calls = [];
  const { sandbox } = loadCode();
  sandbox.performSplitFromEditedAmount_ = function(_sheet, rowNumber, oldAmount, newAmount) {
    calls.push({ rowNumber: rowNumber, oldAmount: oldAmount, newAmount: newAmount });
  };

  sandbox.handleAmountEdit_({}, 2, '90', '84.25');

  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    { rowNumber: 2, oldAmount: 84.25, newAmount: 90 },
  ]);
});

test('handleAmountEdit_ rejects edits for source-only transactions', () => {
  const operations = [];
  const rowStore = new Map([
    [2, {
      transaction_name: 'transactions/txn_1',
      transaction_date: '2025-12-31',
      payee: '',
      narration: 'Guthabenzins: Guthabenzins',
      source_account_name: 'Assets:Bank:Checking',
      destination_account_name: '',
      amount: 1.5,
      split_off_amount: '',
      symbol: 'CHF',
      status: '',
      issues: '',
      last_error: '',
    }],
  ]);
  const { sandbox } = loadCode();
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, operations);

  assert.throws(() => sandbox.handleAmountEdit_(fakeSheet, 2, '1', '1.5'), /Amount cannot be edited/);
  assert.deepEqual(JSON.parse(JSON.stringify(operations)).filter((op) => op.type === 'setValue'), [
    { type: 'setValue', row: 2, value: 1.5 },
  ]);
});

test('rollbackFailedEdit_ clears invalid split_off_amount commands', () => {
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

  sandbox.rollbackFailedEdit_(fakeSheet, 2, 'split_off_amount', '-123');

  assert.deepEqual(JSON.parse(JSON.stringify(operations)), [
    { row: 2, column: 9, value: '' },
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
    { rowNumber: 2, oldAmount: 84.25, newAmount: 50 },
  ]);
});

test('applyTransactionEdit_ treats numeric 0 as a valid new amount for amount column', () => {
  const calls = [];
  const { sandbox } = loadCode();
  sandbox.getTransactionNameForRow_ = function() { return 'transactions/txn_1'; };
  sandbox.handleAmountEdit_ = function(_sheet, rowNumber, rawValue, oldRawValue) {
    calls.push({ rowNumber: rowNumber, rawValue: rawValue, oldRawValue: oldRawValue });
  };
  sandbox.saveTransactionByName_ = function() {};

  sandbox.applyTransactionEdit_({}, 2, 'amount', 0, '84.25', {});

  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    { rowNumber: 2, rawValue: 0, oldRawValue: '84.25' },
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

test('applyTransactionEdit_ treats numeric 0 as a valid split amount for split_off_amount column', () => {
  const calls = [];
  const { sandbox } = loadCode();
  sandbox.getTransactionNameForRow_ = function() { return 'transactions/txn_1'; };
  sandbox.performSplitInstructionForRow_ = function(_sheet, rowNumber, instruction) {
    calls.push({ rowNumber: rowNumber, instruction: instruction });
  };
  sandbox.saveTransactionByName_ = function() {};

  sandbox.applyTransactionEdit_({}, 5, 'split_off_amount', 0, '', {});

  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    { rowNumber: 5, instruction: '0' },
  ]);
});

test('performSplitInstructionForRow_ rejects splits for source-only transactions', () => {
  const rowStore = new Map([
    [2, {
      transaction_name: 'transactions/txn_1',
      transaction_date: '2025-12-31',
      payee: '',
      narration: 'Guthabenzins: Guthabenzins',
      source_account_name: 'Assets:Bank:Checking',
      destination_account_name: '',
      amount: 1.5,
      split_off_amount: '',
      symbol: 'CHF',
      status: '',
      issues: '',
      last_error: '',
    }],
  ]);
  const { sandbox } = loadCode();
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, []);

  assert.throws(() => sandbox.performSplitInstructionForRow_(fakeSheet, 2, '0.5'), /Split is unavailable/);
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

test('areTransactionRowsEquivalentForRefresh_ ignores transient helper fields', () => {
  const { sandbox } = loadCode();

  assert.equal(
    sandbox.areTransactionRowsEquivalentForRefresh_(
      [
        {
          transaction_name: 'transactions/txn_1',
          transaction_date: '2026-04-19',
          payee: 'Migros',
          narration: 'Groceries',
          source_account_name: 'Assets:Bank:Checking',
          destination_account_name: 'Expenses:Food',
          amount: 84.25,
          split_off_amount: '10',
          symbol: 'CHF',
          status: 'saving',
          last_error: 'temporary',
        },
      ],
      [
        {
          transaction_name: 'transactions/txn_1',
          transaction_date: '2026-04-19',
          payee: 'Migros',
          narration: 'Groceries',
          source_account_name: 'Assets:Bank:Checking',
          destination_account_name: 'Expenses:Food',
          amount: 84.25,
          split_off_amount: '',
          symbol: 'CHF',
          status: 'saved',
          last_error: '',
        },
      ]
    ),
    true
  );
});

test('areTransactionRowsEquivalentForRefresh_ detects business-field differences', () => {
  const { sandbox } = loadCode();

  assert.equal(
    sandbox.areTransactionRowsEquivalentForRefresh_(
      [
        {
          transaction_name: 'transactions/txn_1',
          transaction_date: '2026-04-19',
          payee: 'Migros',
          narration: 'Groceries',
          source_account_name: 'Assets:Bank:Checking',
          destination_account_name: 'Expenses:Food',
          amount: 84.25,
          symbol: 'CHF',
        },
      ],
      [
        {
          transaction_name: 'transactions/txn_1',
          transaction_date: '2026-04-19',
          payee: 'Migros',
          narration: 'Groceries',
          source_account_name: 'Assets:Bank:Checking',
          destination_account_name: 'Expenses:Household',
          amount: 84.25,
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
        amount: 84.25,
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
        amount: 84.25,
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

test('hideTechnicalTransactionColumns_ hides transaction_name and last_error columns', () => {
  const operations = [];
  const { sandbox } = loadCode();
  const fakeSheet = {
    hideColumns(column) {
      operations.push(column);
    },
  };

  sandbox.hideTechnicalTransactionColumns_(fakeSheet);

  assert.deepEqual(JSON.parse(JSON.stringify(operations)), [1, 11]);
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

test('saveTransactionByName_ keeps doctor issues and records transient PATCH errors separately', () => {
  const operations = [];
  const rowStore = new Map([
    [2, {
      transaction_name: 'transactions/txn_1',
      transaction_date: '2026-04-19',
      payee: 'Migros',
      narration: 'Groceries',
      source_account_name: 'Assets:Bank:Checking',
      destination_account_name: 'Expenses:Food',
      amount: 84.25,
      split_off_amount: '',
      symbol: 'CHF',
      status: 'dirty',
      issues: 'transaction_unbalanced (CHF, residual -4.25, tolerance 0.005)',
      last_error: '',
    }],
  ]);
  const { sandbox } = loadCode();
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, operations);

  sandbox.loadAccountNameMap_ = function() {
    return {};
  };
  sandbox.buildTransactionPatchPayloadFromGroup_ = function() {
    return { transaction_date: '2026-04-19', postings: [] };
  };
  sandbox.apiFetchJson_ = function(method) {
    if (method === 'patch') {
      throw new Error('transaction_unbalanced: Transaction is not balanced within tolerance.');
    }
    return {};
  };

  sandbox.saveTransactionByName_(fakeSheet, 'transactions/txn_1', {});

  assert.equal(rowStore.get(2).issues, 'transaction_unbalanced (CHF, residual -4.25, tolerance 0.005)');
  assert.equal(
    rowStore.get(2).last_error,
    'transaction_unbalanced: Transaction is not balanced within tolerance.'
  );
  assert.equal(rowStore.get(2).status, 'error');
});

test('refreshTransactionIssuesFromDoctor_ updates issues asynchronously without touching status', () => {
  const operations = [];
  const rowStore = new Map([
    [2, {
      transaction_name: 'transactions/txn_1',
      transaction_date: '2026-04-19',
      payee: 'Migros',
      narration: 'Groceries',
      source_account_name: 'Assets:Bank:Checking',
      destination_account_name: 'Expenses:Food',
      amount: 84.25,
      split_off_amount: '',
      symbol: 'CHF',
      status: 'saved',
      issues: '',
      last_error: '',
    }],
  ]);
  const doctorTransactionSheet = makeRowStoreSheet_(null, new Map(), []);
  const doctorAccountSheet = makeRowStoreSheet_(null, new Map(), []);
  const sheetsByName = {
    DoctorTransactionIssues: doctorTransactionSheet,
    DoctorAccountIssues: doctorAccountSheet,
  };
  const { sandbox } = loadCode({
    SpreadsheetApp: {
      getActiveSpreadsheet() {
        return {
          getSheetByName(name) {
            return sheetsByName[name] || null;
          },
          insertSheet(name) {
            const sheet = makeRowStoreSheet_(sandbox, new Map(), []);
            sheetsByName[name] = sheet;
            return sheet;
          },
          toast() {},
        };
      },
    },
  });
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, operations);

  sandbox.apiFetchJson_ = function(method, path) {
    if (method === 'post' && path === '/ledger:doctor') {
      return {
        issues: [
          {
            target: 'transactions/txn_1',
            code: 'transaction_unbalanced',
            message: 'Transaction is not balanced within tolerance.',
            details: {
              symbol: 'CHF',
              residual_amount: '-4.25',
              tolerance_amount: '0.005',
            },
          },
        ],
      };
    }
    throw new Error('unexpected api call');
  };

  sandbox.refreshTransactionIssuesFromDoctor_(fakeSheet);

  assert.equal(doctorTransactionSheet.getLastRow(), 2);
  assert.equal(rowStore.get(2).status, 'saved');
  assert.equal(rowStore.get(2).last_error, '');
});

test('flattenTransactionForSheet_ passes transaction_date string through unchanged', () => {
  const { sandbox } = loadCode();

  const rows = sandbox.flattenTransactionForSheet_(sampleTransaction(), {
    'accounts/source': 'Assets:Bank:Checking',
    'accounts/food': 'Expenses:Food',
  });

  assert.equal(rows[0].transaction_date, '2026-04-19');
});

test('flattenTransactionForSheet_ date round-trips back to yyyy-MM-dd for API payload', () => {
  const { sandbox } = loadCode();

  const rows = sandbox.flattenTransactionForSheet_(sampleTransaction(), {
    'accounts/source': 'Assets:Bank:Checking',
    'accounts/food': 'Expenses:Food',
  });

  const payload = sandbox.buildTransactionPatchPayloadFromGroup_({
    transactionName: 'transactions/txn_1',
    contiguous: true,
    rows: rows,
  }, {
    'Assets:Bank:Checking': 'accounts/source',
    'Expenses:Food': 'accounts/food',
  });

  assert.equal(payload.transaction_date, '2026-04-19');
});

test('ensureTransactionSheetFilter_ creates a filter covering all transaction columns', () => {
  const operations = [];
  const rowStore = new Map([[2, {
    transaction_name: 'transactions/txn_1', transaction_date: new Date('2026-04-19T00:00:00.000Z'),
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
            getValues() { return dates.slice(0, numRows).map(function(d) { return [d]; }); },
          };
        },
      },
    },
  });

  const years = sandbox.getTransactionFilterYears();
  assert.deepEqual(years, [2026, 2025, 2024]);
});

test('applyTransactionQuickFilter sets range formula for full year', () => {
  const filterCriteria = [];
  const { sandbox } = loadCode({
    sheetsByName: {
      Transactions: {
        getLastRow() { return 5; },
        getFilter() {
          return {
            setColumnFilterCriteria(col, criteria) { filterCriteria.push({ col, criteria }); },
          };
        },
        getRange() { return { createFilter() { return { setColumnFilterCriteria() {} }; } }; },
      },
    },
  });

  sandbox.applyTransactionQuickFilter('2026-01', '2026-12');

  assert.equal(filterCriteria.length, 1);
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
          return {
            setColumnFilterCriteria(col, criteria) { filterCriteria.push({ col, criteria }); },
          };
        },
        getRange() { return { createFilter() { return { setColumnFilterCriteria() {} }; } }; },
      },
    },
  });

  sandbox.applyTransactionQuickFilter('2025-03', '2026-06');

  assert.equal(filterCriteria.length, 1);
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

  assert.deepEqual(removed, [2, 5, 6]);
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

  const names = sandbox.getTransactionAccountNames();
  assert.deepEqual(JSON.parse(JSON.stringify(names)), ['[A] Bank - Checking', '[X] Food - Groceries', '[X] Housing']);
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
        getRange() { return { createFilter() { return { setColumnFilterCriteria() {} }; } }; },
      },
    },
  });

  sandbox.applyTransactionAccountFilter('[X]');

  assert.equal(filterCriteria.length, 1);
  assert.equal(filterCriteria[0].col, 5);
  assert.equal(filterCriteria[0].criteria.formula, '=OR(LEFT(E2,4)="[X] ",LEFT(F2,4)="[X] ")');
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
        getRange() { return { createFilter() { return { setColumnFilterCriteria() {} }; } }; },
      },
    },
  });

  sandbox.applyTransactionAccountFilter('[X] Food');

  assert.equal(filterCriteria.length, 1);
  assert.equal(filterCriteria[0].col, 5);
  assert.equal(filterCriteria[0].criteria.formula, '=OR(E2="[X] Food",LEFT(E2,11)="[X] Food - ",F2="[X] Food",LEFT(F2,11)="[X] Food - ")');
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
        getRange() { return { createFilter() { return { setColumnFilterCriteria() {} }; } }; },
      },
    },
  });

  sandbox.applyTransactionAccountFilter('__blank__');

  assert.equal(filterCriteria.length, 1);
  assert.equal(filterCriteria[0].col, 5);
  assert.equal(filterCriteria[0].criteria.formula, '=F2=""');
});

test('applyTransactionAccountFilter persists prefix in document properties', () => {
  const { sandbox, documentProperties } = loadCode({
    sheetsByName: {
      Transactions: {
        getLastRow() { return 5; },
        getFilter() { return { setColumnFilterCriteria() {} }; },
        getRange() { return { createFilter() { return { setColumnFilterCriteria() {} }; } }; },
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

  assert.deepEqual(removed, [5]);
});

test('applyTransactionQuickFilter persists from/to in document properties', () => {
  const { sandbox, documentProperties } = loadCode({
    sheetsByName: {
      Transactions: {
        getLastRow() { return 5; },
        getFilter() { return { setColumnFilterCriteria() {} }; },
        getRange() { return { createFilter() { return { setColumnFilterCriteria() {} }; } }; },
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
