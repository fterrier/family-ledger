function buildAccountDisplayEntries_(accounts) {
  return accounts.map(function(account) {
    return {
      name: account.name,
      account_name: account.account_name,
      display_name: formatAccountDisplayName_(account.account_name),
    };
  });
}

function formatAccountDisplayName_(accountName) {
  const canonical = String(accountName || '').trim();
  if (!canonical) {
    return canonical;
  }
  const segments = canonical.split(':');
  const root = segments[0];
  const marker = FAMILY_LEDGER_ACCOUNT_ROOT_MARKERS[root] || '[?]';
  const tail = segments.length > 1 ? segments.slice(1) : segments;
  return marker + ' ' + tail.join(' - ');
}

function loadAccountNameMap_() {
  const accountsSheet = getOrCreateSheet_(FAMILY_LEDGER_SHEET_NAMES.accounts);
  const lastRow = accountsSheet.getLastRow();
  const mapping = {};
  if (lastRow <= 1) {
    throw new Error('Accounts sheet is empty. Run Sync Accounts first.');
  }

  const rows = accountsSheet.getRange(2, 1, lastRow - 1, 2).getValues();
  rows.forEach(function(row) {
    if (row[0] && row[1]) {
      mapping[String(row[0])] = String(row[1]);
    }
  });
  return mapping;
}

function resolveAccountResourceName_(accountNameMap, accountName) {
  const resourceName = accountNameMap[accountName];
  if (!resourceName) {
    throw new Error('Unknown account_name: ' + accountName);
  }
  return resourceName;
}

function loadAccountsFromApi_() {
  const accounts = fetchFamilyLedgerPagedResource_(
    '/accounts?page_size=' + FAMILY_LEDGER_PAGE_SIZE,
    'accounts'
  );
  const displayEntries = buildAccountDisplayEntries_(accounts);
  const lookup = {};
  displayEntries.forEach(function(account) {
    lookup[account.name] = account.display_name;
  });
  return lookup;
}
