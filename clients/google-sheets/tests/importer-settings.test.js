const test = require('node:test');
const assert = require('node:assert/strict');

const { loadCode } = require('./_harness');

test('saveImporterSettingsFromDialog patches the importer resource with sparse config payload', () => {
  const { sandbox, properties, fetchCalls } = loadCode();
  properties.set('FAMILY_LEDGER_BASE_URL', 'https://ledger.example');
  properties.set('FAMILY_LEDGER_API_TOKEN', 'secret-token');

  sandbox.saveImporterSettingsFromDialog('importers/mt940', {
    payee_format: 'zkb',
    balance_assertion_frequency: 'weekly',
  });

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, 'https://ledger.example/importers/mt940');
  assert.equal(fetchCalls[0].options.method, 'patch');
  assert.deepEqual(JSON.parse(fetchCalls[0].options.payload), {
    importer: {
      config: {
        payee_format: 'zkb',
        balance_assertion_frequency: 'weekly',
      },
    },
  });
});
