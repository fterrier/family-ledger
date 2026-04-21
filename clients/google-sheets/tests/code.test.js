const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

function loadCode(overrides = {}) {
  const properties = new Map();
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
      ...overrides.SpreadsheetApp,
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
  return { sandbox, properties, fetchCalls };
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

test('normalizeDecimalString_ and sumDecimalStrings_ keep exact decimal semantics', () => {
  const { sandbox } = loadCode();

  assert.equal(sandbox.normalizeDecimalString_('0010.5000'), '10.5');
  assert.equal(sandbox.normalizeDecimalString_('-0.2500'), '-0.25');
  assert.equal(sandbox.sumDecimalStrings_(['50.00', '34.25', '-4.25']), '80');
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
