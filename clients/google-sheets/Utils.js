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

function normalizeTransactionDate_(value) {
  if (Object.prototype.toString.call(value) === '[object Date]') {
    return Utilities.formatDate(value, 'UTC', 'yyyy-MM-dd');
  }
  return String(value || '').trim();
}


function uniqueNonBlankValues_(values) {
  const unique = [];
  values.forEach(function(value) {
    if (!value) {
      return;
    }
    if (unique.indexOf(value) === -1) {
      unique.push(value);
    }
  });
  return unique;
}

function rowToObject_(headers, rowValues) {
  const result = {};
  headers.forEach(function(header, index) {
    result[header] = rowValues[index];
  });
  return result;
}
