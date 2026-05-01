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

test('apiFetchMultipartJson_ includes bearer auth and keeps multipart payload intact', () => {
  const { sandbox, properties, fetchCalls } = loadCode();
  properties.set('FAMILY_LEDGER_BASE_URL', 'https://ledger.example');
  properties.set('FAMILY_LEDGER_API_TOKEN', 'secret-token');

  sandbox.apiFetchMultipartJson_('post', '/importers/imp_1:import', {
    file: { name: 'sample.beancount' },
    config_override: '{"dry_run":true}',
  }, {
    metadata: { fileName: 'sample.beancount' },
  });

  assert.equal(fetchCalls[0].url, 'https://ledger.example/importers/imp_1:import');
  assert.equal(fetchCalls[0].options.headers.Authorization, 'Bearer secret-token');
  assert.deepEqual(fetchCalls[0].options.payload, {
    file: { name: 'sample.beancount' },
    config_override: '{"dry_run":true}',
  });
});

test('apiFetchJson_ logs request and response without logging auth headers', () => {
  const logs = [];
  const { sandbox, properties } = loadCode({
    console: {
      log(message) {
        logs.push(message);
      },
    },
  });
  properties.set('FAMILY_LEDGER_BASE_URL', 'https://ledger.example');
  properties.set('FAMILY_LEDGER_API_TOKEN', 'secret-token');
  properties.set('FAMILY_LEDGER_DEBUG_LOGS', 'true');

  sandbox.apiFetchJson_('patch', '/transactions/txn_1', {
    transaction: {
      narration: 'Groceries',
      postings: [{ narration: 'Produce' }],
    },
  });

  assert.equal(logs.length, 2);
  assert.match(logs[0], /apiFetchJson_:request/);
  assert.match(logs[1], /apiFetchJson_:response/);
  assert.match(logs[0], /"payload"/);
  assert.doesNotMatch(logs[0], /Authorization/);
  assert.doesNotMatch(logs[0], /secret-token/);
});

test('apiFetchJson_ logs fetch errors when debug logging is enabled', () => {
  const logs = [];
  const { sandbox, properties } = loadCode({
    console: {
      log(message) {
        logs.push(message);
      },
    },
    fetchImpl() {
      throw new Error('socket hang up');
    },
  });
  properties.set('FAMILY_LEDGER_BASE_URL', 'https://ledger.example');
  properties.set('FAMILY_LEDGER_API_TOKEN', 'secret-token');
  properties.set('FAMILY_LEDGER_DEBUG_LOGS', 'true');

  assert.throws(() => sandbox.apiFetchJson_('get', '/accounts'), /socket hang up/);

  assert.match(logs[0], /apiFetchJson_:request/);
  assert.match(logs[1], /apiFetchJson_:error/);
  assert.match(logs[1], /socket hang up/);
});

test('apiFetchMultipartJson_ logs request and response without logging auth headers', () => {
  const logs = [];
  const { sandbox, properties } = loadCode({
    console: {
      log(message) {
        logs.push(message);
      },
    },
  });
  properties.set('FAMILY_LEDGER_BASE_URL', 'https://ledger.example');
  properties.set('FAMILY_LEDGER_API_TOKEN', 'secret-token');
  properties.set('FAMILY_LEDGER_DEBUG_LOGS', 'true');

  sandbox.apiFetchMultipartJson_('post', '/importers/imp_1:import', {
    file: { name: 'sample.beancount' },
    config_override: '{"import_posting_comments_as_narration":true}',
  }, {
    metadata: {
      fileName: 'sample.beancount',
      mimeType: 'text/plain',
      configOverride: { import_posting_comments_as_narration: true },
    },
  });

  assert.equal(logs.length, 2);
  assert.match(logs[0], /apiFetchMultipartJson_:request/);
  assert.match(logs[1], /apiFetchMultipartJson_:response/);
  assert.match(logs[0], /sample.beancount/);
  assert.doesNotMatch(logs[0], /Authorization/);
  assert.doesNotMatch(logs[0], /secret-token/);
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

test('apiFetchMultipartJson_ retries on bandwidth quota errors and succeeds', () => {
  let attempts = 0;
  const sleepCalls = [];
  const { sandbox, properties } = loadCode({
    fetchImpl() {
      attempts++;
      if (attempts < 3) {
        throw new Error('Bandwidth quota exceeded: https://ledger.example/import');
      }
      return { getResponseCode() { return 200; }, getContentText() { return '{}'; } };
    },
    Utilities: { sleep(ms) { sleepCalls.push(ms); } },
  });

  properties.set('FAMILY_LEDGER_BASE_URL', 'https://ledger.example');
  properties.set('FAMILY_LEDGER_API_TOKEN', 'secret');

  const result = sandbox.apiFetchMultipartJson_('post', '/importers/imp_1:import', { file: { name: 'sample' } });
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
