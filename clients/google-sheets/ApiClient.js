function fetchFamilyLedgerPagedResource_(path, resourceKey) {
  let nextPath = path;
  const items = [];

  while (nextPath) {
    const response = apiFetchJson_('get', nextPath);
    const pageItems = response[resourceKey] || [];
    pageItems.forEach(function(item) {
      items.push(item);
    });
    nextPath = response.next_page_token
      ? pathWithUpdatedPageToken_(nextPath, response.next_page_token)
      : null;
  }

  return items;
}

function pathWithUpdatedPageToken_(path, pageToken) {
  const parts = path.split('?');
  const basePath = parts[0];
  const query = parts[1] || '';
  const filtered = query
    .split('&')
    .filter(function(part) {
      return part && part.indexOf('page_token=') !== 0;
    });
  filtered.push('page_token=' + encodeURIComponent(pageToken));
  return basePath + '?' + filtered.join('&');
}

function apiFetchJson_(method, path, payload, options) {
  options = options || {};
  const url = buildApiUrl_(path);
  const requestOptions = {
    method: method,
    contentType: 'application/json',
    muteHttpExceptions: true,
  };

  if (payload !== undefined) {
    requestOptions.payload = JSON.stringify(payload);
  }

  if (!options.skipAuth) {
    requestOptions.headers = {
      Authorization: 'Bearer ' + getRequiredFamilyLedgerApiToken_(),
    };
  }

  const response = UrlFetchApp.fetch(url, requestOptions);
  const statusCode = response.getResponseCode();
  const body = response.getContentText();

  if (statusCode >= 400) {
    throw buildApiError_(statusCode, body);
  }

  return body ? JSON.parse(body) : {};
}

function buildApiError_(statusCode, body) {
  if (!body) {
    return new Error('API request failed with status ' + statusCode + '.');
  }

  try {
    const parsed = JSON.parse(body);
    if (parsed.detail && parsed.detail.message) {
      return new Error(parsed.detail.code + ': ' + parsed.detail.message);
    }
  } catch {
    // Fall through to the raw body error below.
  }

  return new Error('API request failed with status ' + statusCode + ': ' + body);
}

function buildApiUrl_(path) {
  const baseUrl = getFamilyLedgerBaseUrl_();
  if (!baseUrl) {
    throw new Error('Missing FAMILY_LEDGER_BASE_URL script property.');
  }
  if (path.charAt(0) === '/') {
    return baseUrl + path;
  }
  return baseUrl + '/' + path;
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
    throw new Error('Missing FAMILY_LEDGER_API_TOKEN. Run Set API Token first.');
  }
  return token;
}
