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
  const requestOptions = {
    method: method,
    contentType: 'application/json',
  };

  if (payload !== undefined) {
    requestOptions.payload = JSON.stringify(payload);
  }

  const response = apiFetch_(method, path, requestOptions, {
    requestEvent: 'apiFetchJson_:request',
    responseEvent: 'apiFetchJson_:response',
    errorEvent: 'apiFetchJson_:error',
    retryEvent: 'apiFetchJson_:bandwidth_retry',
    metadata: {
      skipAuth: !!options.skipAuth,
      payload: payload,
    },
    skipAuth: options.skipAuth,
  });
  const statusCode = response.getResponseCode();
  const body = response.getContentText();

  if (statusCode >= 400) {
    logApiHttpError_(method, path, statusCode);
    throw buildApiError_(statusCode, body, method, path);
  }

  return body ? JSON.parse(body) : {};
}

function apiFetchMultipartJson_(method, path, payload, options) {
  options = options || {};
  const response = apiFetch_(method, path, {
    method: method,
    payload: payload,
  }, {
    requestEvent: 'apiFetchMultipartJson_:request',
    responseEvent: 'apiFetchMultipartJson_:response',
    errorEvent: 'apiFetchMultipartJson_:error',
    retryEvent: 'apiFetchMultipartJson_:bandwidth_retry',
    metadata: options.metadata || {},
    skipAuth: options.skipAuth,
  });
  const statusCode = response.getResponseCode();
  const body = response.getContentText();

  if (statusCode >= 400) {
    logApiHttpError_(method, path, statusCode);
    throw buildApiError_(statusCode, body, method, path);
  }

  return body ? JSON.parse(body) : {};
}

function apiFetch_(method, path, requestOptions, options) {
  options = options || {};
  const url = buildApiUrl_(path);
  const startedAt = Date.now();
  const fetchOptions = Object.assign({ muteHttpExceptions: true }, requestOptions || {});

  if (!options.skipAuth) {
    fetchOptions.headers = Object.assign({}, fetchOptions.headers || {}, {
      Authorization: 'Bearer ' + getRequiredFamilyLedgerApiToken_(),
    });
  }

  logApiRequestStart_(options.requestEvent || 'apiFetch_:request', method, path, url, options.metadata);

  const maxRetries = 3;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = Math.pow(2, attempt - 1) * 5000;
      debugLog_(options.retryEvent || 'apiFetch_:bandwidth_retry', { attempt: attempt, delayMs: delay, url: url });
      Utilities.sleep(delay);
    }
    try {
      const response = UrlFetchApp.fetch(url, fetchOptions);
      const duration = Date.now() - startedAt;
      logApiRequestSuccess_(options.responseEvent || 'apiFetch_:response', method, path, url, response.getResponseCode(), duration, options.metadata);
      const activePerf = getActivePerf_();
      if (activePerf) activePerf.record('api.' + method.toUpperCase() + ' ' + path.split('?')[0], duration, response.getResponseCode());
      return response;
    } catch (error) {
      if (isBandwidthQuotaError_(error) && attempt < maxRetries) {
        continue;
      }
      logApiRequestError_(options.errorEvent || 'apiFetch_:error', method, path, url, Date.now() - startedAt, error, options.metadata);
      throw error;
    }
  }

  throw new Error('API request failed without a response.');
}

function logApiRequestStart_(eventName, method, path, url, metadata) {
  debugLog_(eventName, Object.assign({ method: method, path: path, url: url }, metadata || {}));
}

function logApiRequestSuccess_(eventName, method, path, url, status, durationMs, metadata) {
  debugLog_(eventName, Object.assign({
    method: method,
    path: path,
    url: url,
    status: status,
    durationMs: durationMs,
  }, metadata || {}));
}

function logApiRequestError_(eventName, method, path, url, durationMs, error, metadata) {
  debugLog_(eventName, Object.assign({
    method: method,
    path: path,
    url: url,
    durationMs: durationMs,
    message: error && error.message ? error.message : String(error),
  }, metadata || {}));
}

function logApiHttpError_(method, path, statusCode) {
  console.error('[family-ledger] api http error', method.toUpperCase(), path, statusCode);
}

function isBandwidthQuotaError_(error) {
  return !!(error && error.message && error.message.indexOf('Bandwidth quota exceeded') !== -1);
}

function buildApiError_(statusCode, body, method, path) {
  const context = method && path ? ' (' + method.toUpperCase() + ' ' + path + ')' : '';
  if (!body) {
    return new Error('API request failed with status ' + statusCode + context);
  }

  try {
    const parsed = JSON.parse(body);
    if (parsed.detail && parsed.detail.message) {
      return new Error(statusCode + ' ' + parsed.detail.code + ': ' + parsed.detail.message + context);
    }
  } catch {
    // Fall through to the raw body error below.
  }

  return new Error('API request failed with status ' + statusCode + context + ': ' + body);
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
