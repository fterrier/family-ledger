function runUserAction_(actionName, fn) {
  try {
    return fn();
  } catch (error) {
    reportUserError_(actionName, error);
    return null;
  }
}

function reportUserError_(actionName, error) {
  const message = error && error.message ? error.message : String(error);
  SpreadsheetApp.getUi().alert(actionName + ' Failed', message, SpreadsheetApp.getUi().ButtonSet.OK);
}

function getFamilyLedgerDebugLogsEnabled_() {
  const value = PropertiesService.getScriptProperties().getProperty('FAMILY_LEDGER_DEBUG_LOGS');
  return String(value || '').trim().toLowerCase() === 'true';
}

function debugLog_(eventName, fields) {
  if (!getFamilyLedgerDebugLogsEnabled_()) {
    return;
  }
  let serializedFields = '{}';
  try {
    serializedFields = JSON.stringify(fields || {});
  } catch {
    serializedFields = '{"serialization_error":true}';
  }
  console.log('[family-ledger] ' + eventName + ' ' + serializedFields);
}

function normalizeBaseUrl_(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    throw new Error('API base URL cannot be blank.');
  }
  return trimmed.replace(/\/+$/, '');
}

function normalizeApiToken_(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    throw new Error('API token cannot be blank.');
  }
  return trimmed;
}

function getFamilyLedgerBaseUrl_() {
  return PropertiesService.getScriptProperties().getProperty('FAMILY_LEDGER_BASE_URL');
}

function getFamilyLedgerApiToken_() {
  return PropertiesService.getScriptProperties().getProperty('FAMILY_LEDGER_API_TOKEN');
}

function getRequiredFamilyLedgerApiToken_() {
  const token = getFamilyLedgerApiToken_();
  if (!token) {
    throw new Error('Missing FAMILY_LEDGER_API_TOKEN. Run API Settings first.');
  }
  return token;
}

function showApiSettings() {
  const html = HtmlService.createHtmlOutputFromFile('ApiSettingsDialog')
    .setWidth(420)
    .setHeight(220);
  SpreadsheetApp.getUi().showModalDialog(html, 'API Settings');
}

function getApiSettingsForDialog() {
  return {
    baseUrl: getFamilyLedgerBaseUrl_() || '',
    apiToken: getFamilyLedgerApiToken_() || '',
  };
}

function saveApiSettingsFromDialog(baseUrl, apiToken) {
  PropertiesService.getScriptProperties().setProperties({
    FAMILY_LEDGER_BASE_URL: normalizeBaseUrl_(baseUrl),
    FAMILY_LEDGER_API_TOKEN: normalizeApiToken_(apiToken),
  });
}


function testFamilyLedgerConnection() {
  runUserAction_('Test Connection', function() {
    const ui = SpreadsheetApp.getUi();
    const baseUrl = getFamilyLedgerBaseUrl_();
    const apiToken = getFamilyLedgerApiToken_();
    if (!baseUrl) {
      throw new Error('Missing FAMILY_LEDGER_BASE_URL. Run API Settings first.');
    }
    if (!apiToken) {
      throw new Error('Missing FAMILY_LEDGER_API_TOKEN. Run API Settings first.');
    }

    let healthMessage = 'not checked';
    let authMessage = 'not checked';

    try {
      const health = apiFetchJson_('get', '/healthz', undefined, { skipAuth: true });
      healthMessage = health.status === 'ok' ? 'ok' : 'unexpected response';
    } catch (error) {
      healthMessage = error.message;
    }

    if (healthMessage === 'ok') {
      try {
        apiFetchJson_('get', '/accounts?page_size=1');
        authMessage = 'ok';
      } catch (error) {
        authMessage = error.message;
      }
    }

    ui.alert(
      'Family Ledger Connection Test',
      'Health: ' + healthMessage + '\n' + 'Ledger auth: ' + authMessage,
      ui.ButtonSet.OK
    );
  });
}
