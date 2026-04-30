function showImportDialog() {
  const html = HtmlService.createHtmlOutputFromFile('ImportDialog')
    .setWidth(480)
    .setHeight(560);
  SpreadsheetApp.getUi().showModalDialog(html, 'Import data');
}

function getImportersForDialog() {
  return apiFetchJson_('GET', '/importers', undefined);
}

function getAccountsForDialog() {
  return fetchFamilyLedgerPagedResource_('/accounts?page_size=500', 'accounts');
}

function runImportFromDialog(importerName, base64Content, mimeType, fileName, configOverride) {
  const bytes = Utilities.base64Decode(base64Content);
  const blob = Utilities.newBlob(bytes, mimeType || 'application/octet-stream', fileName);
  const url = buildApiUrl_(importerName + ':import');
  const resp = UrlFetchApp.fetch(url, {
    method: 'post',
    muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + getRequiredFamilyLedgerApiToken_() },
    payload: {
      file: blob,
      config_override: configOverride ? JSON.stringify(configOverride) : '',
    },
  });
  const statusCode = resp.getResponseCode();
  const body = resp.getContentText();
  if (statusCode >= 400) {
    const err = buildApiError_(statusCode, body);
    SpreadsheetApp.getActiveSpreadsheet().toast(err.message, 'Import failed', 10);
    throw err;
  }
  const result = JSON.parse(body);
  SpreadsheetApp.getActiveSpreadsheet()
    .toast(buildImportToastSummary_(result.result), 'Import complete', 15);
  return result;
}

function buildImportToastSummary_(result) {
  const entities = result.entities || {};
  const parts = Object.keys(entities).map(function(type) {
    const counts = entities[type];
    return counts.created + ' ' + type + (counts.created !== 1 ? 's' : '') + ' created';
  });
  return parts.length ? parts.join(', ') : 'No entities imported';
}
