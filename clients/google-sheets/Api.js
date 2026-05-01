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
  const startedAt = Date.now();
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

  debugLog_('apiFetchJson_:request', {
    method: method,
    path: path,
    url: url,
    skipAuth: !!options.skipAuth,
    payload: payload,
  });

  const maxRetries = 3;
  let response;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = Math.pow(2, attempt - 1) * 5000; // 5 s, 10 s, 20 s
      debugLog_('apiFetchJson_:bandwidth_retry', { attempt: attempt, delayMs: delay, url: url });
      Utilities.sleep(delay);
    }
    try {
      response = UrlFetchApp.fetch(url, requestOptions);
      break;
    } catch (error) {
      if (isBandwidthQuotaError_(error) && attempt < maxRetries) {
        continue;
      }
      debugLog_('apiFetchJson_:error', {
        method: method,
        path: path,
        url: url,
        durationMs: Date.now() - startedAt,
        message: error && error.message ? error.message : String(error),
      });
      throw error;
    }
  }

  const statusCode = response.getResponseCode();
  const body = response.getContentText();

  debugLog_('apiFetchJson_:response', {
    method: method,
    path: path,
    url: url,
    status: statusCode,
    durationMs: Date.now() - startedAt,
  });

  if (statusCode >= 400) {
    throw buildApiError_(statusCode, body);
  }

  return body ? JSON.parse(body) : {};
}

function isBandwidthQuotaError_(error) {
  return !!(error && error.message && error.message.indexOf('Bandwidth quota exceeded') !== -1);
}

function buildApiError_(statusCode, body) {
  if (!body) {
    return new Error('API request failed with status ' + statusCode + '.');
  }

  try {
    const parsed = JSON.parse(body);
    if (parsed.detail && parsed.detail.message) {
      return new Error(statusCode + ' ' + parsed.detail.code + ': ' + parsed.detail.message);
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
