const test = require('node:test');
const assert = require('node:assert/strict');

const { loadCode } = require('./_harness');

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
