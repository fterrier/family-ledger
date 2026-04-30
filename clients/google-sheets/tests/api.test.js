const test = require('node:test');
const assert = require('node:assert/strict');

const { loadCode } = require('./_harness');

test('pathWithUpdatedPageToken_ preserves query parameters and replaces page_token', () => {
  const { sandbox } = loadCode();

  assert.equal(
    sandbox.pathWithUpdatedPageToken_('/transactions?page_size=100&page_token=old&from_date=2026-01-01', 'new token'),
    '/transactions?page_size=100&from_date=2026-01-01&page_token=new%20token'
  );
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
  assert.equal(attempts, 4);
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
