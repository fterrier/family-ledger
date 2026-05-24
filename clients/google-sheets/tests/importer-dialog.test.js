const test = require('node:test');
const assert = require('node:assert/strict');

const { loadCode } = require('./_harness');

test('showImportDialog opens ImporterDialog in import mode with embedded importers', () => {
  let templateName = null;
  let templateData = null;
  let width = null;
  let height = null;
  const dialogs = [];
  const { sandbox } = loadCode({
    HtmlService: {
      createTemplateFromFile(name) {
        templateName = name;
        templateData = {};
        return Object.assign(templateData, {
          evaluate() {
            return {
              setWidth(value) {
                width = value;
                return this;
              },
              setHeight(value) {
                height = value;
                return this;
              },
            };
          },
        });
      },
    },
    SpreadsheetApp: {
      getUi() {
        return {
          showModalDialog(html, title) {
            dialogs.push({ html, title });
          },
        };
      },
    },
  });
  sandbox.getImportersForDialog = function() {
    return { importers: [{ name: 'importers/mt940' }] };
  };

  sandbox.showImportDialog();

  assert.equal(templateName, 'ImporterDialog');
  assert.equal(templateData.mode, 'import');
  assert.equal(templateData.initialImportersJson, '[{"name":"importers/mt940"}]');
  assert.equal(width, 480);
  assert.equal(height, 560);
  assert.equal(dialogs.length, 1);
  assert.equal(dialogs[0].title, 'Import data');
});

test('showImporterSettings opens ImporterDialog in settings mode with embedded importers', () => {
  let templateName = null;
  let templateData = null;
  let width = null;
  let height = null;
  const dialogs = [];
  const { sandbox } = loadCode({
    HtmlService: {
      createTemplateFromFile(name) {
        templateName = name;
        templateData = {};
        return Object.assign(templateData, {
          evaluate() {
            return {
              setWidth(value) {
                width = value;
                return this;
              },
              setHeight(value) {
                height = value;
                return this;
              },
            };
          },
        });
      },
    },
    SpreadsheetApp: {
      getUi() {
        return {
          showModalDialog(html, title) {
            dialogs.push({ html, title });
          },
        };
      },
    },
  });
  sandbox.getImportersForDialog = function() {
    return { importers: [{ name: 'importers/mt940' }] };
  };

  sandbox.showImporterSettings();

  assert.equal(templateName, 'ImporterDialog');
  assert.equal(templateData.mode, 'settings');
  assert.equal(templateData.initialImportersJson, '[{"name":"importers/mt940"}]');
  assert.equal(width, 520);
  assert.equal(height, 560);
  assert.equal(dialogs.length, 1);
  assert.equal(dialogs[0].title, 'Importer Settings');
});

test('getImportersForDialog fetches importer resources', () => {
  const { sandbox, properties, fetchCalls } = loadCode();
  properties.set('FAMILY_LEDGER_BASE_URL', 'https://ledger.example');
  properties.set('FAMILY_LEDGER_API_TOKEN', 'secret-token');

  sandbox.getImportersForDialog();

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, 'https://ledger.example/importers');
  assert.equal(fetchCalls[0].options.method, 'GET');
});

test('buildImportToastSummary_ summarises created entity counts', () => {
  const { sandbox } = loadCode();

  const summary = sandbox.buildImportToastSummary_({
    entities: {
      transaction: { created: 2 },
      account: { created: 1 },
    },
  });

  assert.ok(summary.includes('2 transactions created'), 'pluralises transaction count');
  assert.ok(summary.includes('1 account created'), 'singular for account');
});

test('buildImportToastSummary_ returns fallback when no entities created', () => {
  const { sandbox } = loadCode();

  const summary = sandbox.buildImportToastSummary_({ entities: {} });

  assert.equal(summary, 'No entities imported');
});

test('getAccountsForDialog maps account resources for the dialog', () => {
  const { sandbox } = loadCode();
  sandbox.fetchFamilyLedgerPagedResource_ = function(path, resourceKey) {
    assert.equal(path, '/accounts?page_size=500');
    assert.equal(resourceKey, 'accounts');
    return [
      { name: 'accounts/checking', account_name: 'Assets:Bank:Checking' },
      { name: 'accounts/food', account_name: 'Expenses:Food' },
    ];
  };
  sandbox.formatAccountDisplayName_ = function(accountName) {
    return 'fmt:' + accountName;
  };

  const result = JSON.parse(JSON.stringify(sandbox.getAccountsForDialog()));

  assert.deepEqual(result, [
    { name: 'accounts/checking', display_name: 'fmt:Assets:Bank:Checking' },
    { name: 'accounts/food', display_name: 'fmt:Expenses:Food' },
  ]);
});
