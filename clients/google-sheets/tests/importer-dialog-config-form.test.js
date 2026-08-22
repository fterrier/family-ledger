const test = require('node:test');
const assert = require('node:assert/strict');

const { loadImporterDialog } = require('./_importer_dialog_harness');

const STATIC_IDS = [
  { id: 'phaseLoading' },
  { id: 'loadingMsg' },
  { id: 'phaseForm' },
  { id: 'importerSelect', tagName: 'select' },
  { id: 'configFields' },
  { id: 'errorBox' },
  { id: 'submitBtn', tagName: 'button' },
];

function makeImporter(config) {
  return {
    name: 'ibkr',
    display_name: 'IBKR',
    schema: {
      properties: {
        commissions_account: {
          type: 'string',
          title: 'Commissions account',
          'x-resource-type': 'account',
        },
      },
    },
    config: config || {},
  };
}

function findByTag(root, tag) {
  if (!root) return null;
  if (root.tagName === tag) return root;
  for (const child of root.children || []) {
    const found = findByTag(child, tag);
    if (found) return found;
  }
  return null;
}

test('renderConfigForm shows a visible error and leaves accountsCache unset when getAccountsForDialog fails', () => {
  const importer = makeImporter({ commissions_account: 'accounts/checking' });
  const { sandbox, document, scriptRunCalls } = loadImporterDialog('settings', [importer], STATIC_IDS);

  const call = scriptRunCalls.find(function(c) { return c.method === 'getAccountsForDialog'; });
  assert.ok(call, 'expected getAccountsForDialog to have been called');

  call.onFailure(new Error('boom'));

  const configFields = document.getElementById('configFields');
  const note = configFields.children[0];
  assert.ok(note, 'expected an error note to be rendered');
  assert.match(note.textContent, /Failed to load accounts: boom/);
  assert.equal(sandbox.accountsCache, null, 'a real failure must not be cached as "zero accounts"');
  assert.equal(
    document.getElementById('submitBtn').disabled,
    true,
    'Save must be disabled while no fields are rendered, or Save would submit an empty config and wipe the importer\'s stored settings'
  );
});

test('a stale accounts response cannot clobber the form for an importer selected afterward', () => {
  const importerA = makeImporter({ commissions_account: 'accounts/checking' });
  const importerB = {
    name: 'mt940',
    display_name: 'MT940',
    schema: { properties: { note: { type: 'string', title: 'Note' } } },
    config: {},
  };
  const { sandbox, document, scriptRunCalls } = loadImporterDialog('settings', [importerA, importerB], STATIC_IDS);

  const staleCall = scriptRunCalls.find(function(c) { return c.method === 'getAccountsForDialog'; });
  assert.ok(staleCall, 'expected importer A (selected first) to have kicked off an accounts fetch');

  // Switch away to B (which needs no accounts, so it renders synchronously)
  // before A's in-flight fetch resolves.
  sandbox.selectImporter(importerB);

  const configFields = document.getElementById('configFields');
  const noteField = findByTag(configFields, 'INPUT');
  assert.ok(noteField, 'expected B\'s plain text field to have rendered');

  // A's stale request finally settles — it must be a no-op now.
  staleCall.onFailure(new Error('stale boom'));

  assert.equal(sandbox.accountsCache, null, 'a stale failure must not mutate the shared accounts cache either');
  assert.equal(
    findByTag(configFields, 'INPUT'),
    noteField,
    'B\'s rendered field must still be there — the stale failure for A must not have replaced it with an error'
  );
  assert.equal(
    document.getElementById('submitBtn').disabled,
    false,
    'B is fully rendered and selected; Save must stay enabled despite A\'s stale failure'
  );
});

test('renderConfigForm disables Save while the account fetch is still pending', () => {
  const importer = makeImporter({ commissions_account: 'accounts/checking' });
  const { document, scriptRunCalls } = loadImporterDialog('settings', [importer], STATIC_IDS);

  assert.ok(scriptRunCalls.some(function(c) { return c.method === 'getAccountsForDialog'; }));
  assert.equal(
    document.getElementById('submitBtn').disabled,
    true,
    'Save must stay disabled until the config form has actually rendered'
  );
});

test('renderConfigForm retries the fetch when the importer is reselected after a failure', () => {
  const importer = makeImporter({ commissions_account: 'accounts/checking' });
  const { sandbox, scriptRunCalls } = loadImporterDialog('settings', [importer], STATIC_IDS);

  const firstCall = scriptRunCalls.find(function(c) { return c.method === 'getAccountsForDialog'; });
  firstCall.onFailure(new Error('boom'));

  sandbox.selectImporter(importer);

  const accountCalls = scriptRunCalls.filter(function(c) { return c.method === 'getAccountsForDialog'; });
  assert.equal(accountCalls.length, 2, 'a failed fetch should retry on the next render, not be stuck forever');
});

test('renderConfigForm renders account options when getAccountsForDialog succeeds', () => {
  const importer = makeImporter({ commissions_account: 'accounts/checking' });
  const { document, scriptRunCalls } = loadImporterDialog('settings', [importer], STATIC_IDS);

  const call = scriptRunCalls.find(function(c) { return c.method === 'getAccountsForDialog'; });
  call.onSuccess([{ name: 'accounts/checking', display_name: 'Assets - Checking' }]);

  const configFields = document.getElementById('configFields');
  const select = findByTag(configFields, 'SELECT');
  assert.ok(select, 'expected the account field to render as a select');
  assert.equal(select.options.length, 2, 'blank placeholder plus one account');
  assert.equal(select.options[1].value, 'accounts/checking');
  assert.equal(select.options[1].textContent, 'Assets - Checking');

  const valueText = findByTag(configFields, 'SPAN');
  assert.equal(valueText.textContent, 'Assets - Checking', 'the stored account should show in the closed dropdown box');

  assert.equal(
    document.getElementById('submitBtn').disabled,
    false,
    'Save should be re-enabled once the config form has actually rendered'
  );
});

const IMPORT_STATIC_IDS = STATIC_IDS.concat([
  { id: 'fileInputsSection' },
  { id: 'submitStatus' },
]);

test('updateSubmitButton keeps Import disabled when the config form failed to render, even if all required files are chosen', () => {
  const importer = {
    name: 'ibkr',
    display_name: 'IBKR',
    schema: {
      properties: {
        commissions_account: { type: 'string', title: 'Commissions account', 'x-resource-type': 'account' },
      },
    },
    config: {},
    file_descriptors: [{ name: 'file', label: 'File', required: true, accept: [] }],
  };
  const { sandbox, document, scriptRunCalls } = loadImporterDialog('import', [importer], IMPORT_STATIC_IDS);

  const call = scriptRunCalls.find(function(c) { return c.method === 'getAccountsForDialog'; });
  call.onFailure(new Error('boom'));

  // Simulate the user picking the required file after the accounts fetch failed.
  sandbox.pendingFiles.file = { base64: 'x', mimeType: 'text/csv', name: 'a.csv' };
  sandbox.updateSubmitButton();

  assert.equal(
    document.getElementById('submitBtn').disabled,
    true,
    'the account field never rendered, so submitting now would silently drop it from the import config'
  );
});
