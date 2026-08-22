const test = require('node:test');
const assert = require('node:assert/strict');

const { loadImporterDialog } = require('./_importer_dialog_harness');

const IMPORT_STATIC_IDS = [
  { id: 'phaseLoading' },
  { id: 'loadingMsg' },
  { id: 'phaseForm' },
  { id: 'importerSelect', tagName: 'select' },
  { id: 'configFields' },
  { id: 'errorBox' },
  { id: 'submitBtn', tagName: 'button' },
  { id: 'submitStatus' },
  { id: 'fileInputsSection' },
  { id: 'phaseResult' },
  { id: 'entityBody' },
  { id: 'warningsSection' },
  { id: 'warningsList' },
];

function makeImporter(overrides) {
  return Object.assign({
    name: 'mt940',
    display_name: 'MT940',
    schema: { properties: {} },
    config: {},
    file_descriptors: [],
  }, overrides || {});
}

test('onImport surfaces a warning instead of failing silently when the post-import sheet refresh fails', () => {
  const importer = makeImporter();
  const { sandbox, document, scriptRunCalls } = loadImporterDialog('import', [importer], IMPORT_STATIC_IDS);

  sandbox.onImport();

  const importCall = scriptRunCalls.find(function(c) { return c.method === 'runImportFromDialog'; });
  assert.ok(importCall, 'expected runImportFromDialog to have been called');
  importCall.onSuccess({ result: { entities: {}, warnings: [] } });

  const syncCall = scriptRunCalls.find(function(c) { return c.method === 'syncLedgerAfterImport'; });
  assert.ok(syncCall, 'expected syncLedgerAfterImport to have been called');
  syncCall.onFailure(new Error('sync boom'));

  assert.equal(
    document.getElementById('phaseResult').style.display,
    'block',
    'the import itself succeeded, so the result screen should still show'
  );

  const warningsSection = document.getElementById('warningsSection');
  assert.equal(warningsSection.style.display, 'block', 'a sync failure must not be silently swallowed');

  const warningItems = document.getElementById('warningsList').children;
  assert.equal(warningItems.length, 1);
  assert.match(warningItems[0].textContent, /Sheets refresh failed: sync boom/);
});

test('onImport shows no warning when the post-import sheet refresh succeeds', () => {
  const importer = makeImporter();
  const { sandbox, document, scriptRunCalls } = loadImporterDialog('import', [importer], IMPORT_STATIC_IDS);

  sandbox.onImport();

  const importCall = scriptRunCalls.find(function(c) { return c.method === 'runImportFromDialog'; });
  importCall.onSuccess({ result: { entities: {}, warnings: [] } });

  const syncCall = scriptRunCalls.find(function(c) { return c.method === 'syncLedgerAfterImport'; });
  syncCall.onSuccess();

  const warningsSection = document.getElementById('warningsSection');
  assert.equal(warningsSection.style.display, 'none');
});
