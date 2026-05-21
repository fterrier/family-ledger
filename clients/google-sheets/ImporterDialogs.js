function showImportDialog() {
  showImporterDialog_({
    mode: 'import',
    title: 'Import data',
    width: 480,
    height: 560,
  });
}

function showImporterSettings() {
  showImporterDialog_({
    mode: 'settings',
    title: 'Importer Settings',
    width: 520,
    height: 560,
  });
}

function showImporterDialog_(options) {
  const dialogOptions = options || {};
  const template = HtmlService.createTemplateFromFile('ImporterDialog');
  template.mode = dialogOptions.mode || 'import';
  template.initialImportersJson = JSON.stringify(getImportersForDialog().importers || []);
  const html = template.evaluate()
    .setWidth(dialogOptions.width || 480)
    .setHeight(dialogOptions.height || 560);
  SpreadsheetApp.getUi().showModalDialog(html, dialogOptions.title || 'Importer Dialog');
}

function getImportersForDialog() {
  return apiFetchJson_('GET', '/importers', undefined);
}

function getAccountsForDialog() {
  const accounts = fetchFamilyLedgerPagedResource_('/accounts?page_size=500', 'accounts');
  return accounts.map(function(account) {
    return {
      name: account.name,
      display_name: formatAccountDisplayName_(account.account_name),
    };
  });
}

function runImportFromDialog(importerName, filesMap, configOverride) {
  const perf = createPerf_();
  setActivePerf_(perf);
  try {
    const parts = {
      config_override: configOverride ? JSON.stringify(configOverride) : '',
    };
    Object.keys(filesMap).forEach(function(fieldName) {
      const f = filesMap[fieldName];
      const bytes = Utilities.base64Decode(f.base64);
      parts[fieldName] = Utilities.newBlob(bytes, f.mimeType || 'application/octet-stream', f.name);
    });
    const result = apiFetchMultipartJson_('post', importerName + ':import', parts, {
      metadata: {
        filesMap: filesMap,
        configOverride: configOverride || null,
      },
    });

    if (!result || !result.result) {
      const err = new Error('Import response missing result payload.');
      SpreadsheetApp.getActiveSpreadsheet().toast(err.message, 'Import failed', 10);
      throw err;
    }

    const summary = perf.wrap('data.parse_result', function() {
      return buildImportToastSummary_(result.result);
    }, function(s) { return s; });

    SpreadsheetApp.getActiveSpreadsheet().toast(summary, 'Import complete', 15);
    return result;
  } finally {
    clearActivePerf_();
    perf.log('Import');
  }
}

function saveImporterSettingsFromDialog(importerName, config) {
  return apiFetchJson_('patch', importerName, {
    importer: {
      config: config || {},
    },
  });
}

function buildImportToastSummary_(result) {
  const entities = result.entities || {};
  const parts = Object.keys(entities).map(function(type) {
    const counts = entities[type];
    return counts.created + ' ' + type + (counts.created !== 1 ? 's' : '') + ' created';
  });
  return parts.length ? parts.join(', ') : 'No entities imported';
}
