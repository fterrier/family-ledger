const test = require('node:test');
const assert = require('node:assert/strict');

const { loadCode } = require('./_harness');

test('runImportFromDialog posts multipart import data and returns the result payload', () => {
  const toasts = [];
  const { sandbox } = loadCode({
    Utilities: {
      base64Decode(value) {
        assert.equal(value, 'aGVsbG8=');
        return [104, 101, 108, 108, 111];
      },
      newBlob(bytes, mimeType, fileName) {
        return { bytes, mimeType, fileName };
      },
      sleep(_ms) {},
    },
    SpreadsheetApp: {
      getActiveSpreadsheet() {
        return {
          toast(message, title, seconds) {
            toasts.push({ message, title, seconds });
          },
        };
      },
    },
  });
  let apiCall = null;
  sandbox.apiFetchMultipartJson_ = function(method, path, payload, options) {
    apiCall = { method, path, payload, options };
    return {
      result: {
        entities: {
          transaction: { created: 2 },
          account: { created: 1 },
        },
      },
    };
  };

  const result = sandbox.runImportFromDialog(
    'importers/mt940',
    { file: { base64: 'aGVsbG8=', mimeType: 'text/plain', name: 'sample.mt940' } },
    { payee_format: 'zkb' }
  );

  assert.deepEqual(JSON.parse(JSON.stringify(apiCall)), {
    method: 'post',
    path: 'importers/mt940:import',
    payload: {
      file: {
        bytes: [104, 101, 108, 108, 111],
        mimeType: 'text/plain',
        fileName: 'sample.mt940',
      },
      config_override: '{"payee_format":"zkb"}',
    },
    options: {
      metadata: {
        filesMap: { file: { base64: 'aGVsbG8=', mimeType: 'text/plain', name: 'sample.mt940' } },
        configOverride: { payee_format: 'zkb' },
      },
    },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    result: {
      entities: {
        transaction: { created: 2 },
        account: { created: 1 },
      },
    },
  });
  assert.deepEqual(toasts, [
    {
      message: '2 transactions created, 1 account created',
      title: 'Import complete',
      seconds: 15,
    },
  ]);
});

test('runImportFromDialog sends empty config_override when no override is provided', () => {
  const { sandbox } = loadCode({
    Utilities: {
      base64Decode() {
        return [];
      },
      newBlob(bytes, mimeType, fileName) {
        return { bytes, mimeType, fileName };
      },
      sleep(_ms) {},
    },
    SpreadsheetApp: {
      getActiveSpreadsheet() {
        return {
          toast() {},
        };
      },
    },
  });
  let payload = null;
  sandbox.apiFetchMultipartJson_ = function(_method, _path, requestPayload) {
    payload = requestPayload;
    return { result: { entities: {} } };
  };

  sandbox.runImportFromDialog('importers/mt940', { file: { base64: 'aGVsbG8=', mimeType: '', name: 'sample.mt940' } });

  assert.equal(payload.config_override, '');
});

test('runImportFromDialog throws and toasts when the import response is missing a result payload', () => {
  const toasts = [];
  const { sandbox } = loadCode({
    Utilities: {
      base64Decode() {
        return [];
      },
      newBlob(bytes, mimeType, fileName) {
        return { bytes, mimeType, fileName };
      },
      sleep(_ms) {},
    },
    SpreadsheetApp: {
      getActiveSpreadsheet() {
        return {
          toast(message, title, seconds) {
            toasts.push({ message, title, seconds });
          },
        };
      },
    },
  });
  sandbox.apiFetchMultipartJson_ = function() {
    return {};
  };

  assert.throws(
    () => sandbox.runImportFromDialog('importers/mt940', { file: { base64: 'aGVsbG8=', mimeType: '', name: 'sample.mt940' } }),
    /Import response missing result payload/
  );
  assert.deepEqual(toasts, [
    {
      message: 'Import response missing result payload.',
      title: 'Import failed',
      seconds: 10,
    },
  ]);
});

test('buildImportToastSummary_ summarizes created entities and empty results', () => {
  const { sandbox } = loadCode();

  assert.equal(sandbox.buildImportToastSummary_({
    entities: {
      transaction: { created: 2 },
      account: { created: 1 },
    },
  }), '2 transactions created, 1 account created');
  assert.equal(sandbox.buildImportToastSummary_({ entities: {} }), 'No entities imported');
});
