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

function maskToken_(token) {
  if (token.length <= 8) {
    return '********';
  }
  return token.slice(0, 4) + '...' + token.slice(-4);
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
  runUserAction_('API Settings', function() {
    const ui = SpreadsheetApp.getUi();

    const currentUrl = getFamilyLedgerBaseUrl_();
    const urlResponse = ui.prompt(
      'API Settings (1/2) — Base URL',
      currentUrl || 'http://localhost:8000',
      ui.ButtonSet.OK_CANCEL
    );
    if (urlResponse.getSelectedButton() !== ui.Button.OK) {
      return;
    }
    const baseUrl = normalizeBaseUrl_(urlResponse.getResponseText());

    const currentToken = getFamilyLedgerApiToken_();
    const tokenResponse = ui.prompt(
      'API Settings (2/2) — Token',
      currentToken || 'Paste the bearer token configured on the server.',
      ui.ButtonSet.OK_CANCEL
    );
    if (tokenResponse.getSelectedButton() !== ui.Button.OK) {
      return;
    }
    const token = normalizeApiToken_(tokenResponse.getResponseText());

    PropertiesService.getScriptProperties().setProperties({
      FAMILY_LEDGER_BASE_URL: baseUrl,
      FAMILY_LEDGER_API_TOKEN: token,
    });
    ui.alert('API Settings', 'Saved.\nBase URL: ' + baseUrl + '\nToken: ' + maskToken_(token), ui.ButtonSet.OK);
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
