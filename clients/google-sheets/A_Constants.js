const FAMILY_LEDGER_SHEET_NAMES = {
  accounts: 'Accounts',
  transactions: 'Transactions',
  balances: 'Balances',
  commodities: 'Commodities',
  issues: 'Issues',
};

const FAMILY_LEDGER_PAGE_SIZE = 1000;

const FAMILY_LEDGER_DOCTOR_TARGET_REGISTRY = Object.freeze([
  Object.freeze({
    targetPrefix: 'transactions/',
    visibleSheetName: FAMILY_LEDGER_SHEET_NAMES.transactions,
  }),
  Object.freeze({
    targetPrefix: 'accounts/',
    visibleSheetName: FAMILY_LEDGER_SHEET_NAMES.accounts,
  }),
  Object.freeze({
    targetPrefix: 'balanceAssertions/',
    visibleSheetName: FAMILY_LEDGER_SHEET_NAMES.balances,
  }),
]);

const FAMILY_LEDGER_ACCOUNT_ROOT_MARKERS = {
  Assets: '[A]',
  Liabilities: '[L]',
  Expenses: '[X]',
  Income: '[I]',
  Equity: '[Q]',
};

const FAMILY_LEDGER_HEADER_ROLE_COLORS = {
  readonly: '#d1d5db',
  editable: '#dbeafe',
  action: '#fde68a',
  system: '#e5e7eb',
};

function buildSheetConfig_(key, name, columnLayout, options) {
  const headers = Object.keys(columnLayout);
  const columns = headers.reduce(function(result, header, index) {
    result[header] = Object.freeze({ index: index, column: index + 1 });
    return result;
  }, {});

  return Object.freeze({
    key: key,
    name: name,
    headers: Object.freeze(headers),
    columns: Object.freeze(columns),
    columnLayout: Object.freeze(columnLayout),
    hiddenHeaders: Object.freeze((options && options.hiddenHeaders) || []),
    protectedHeaders: Object.freeze((options && options.protectedHeaders) || []),
    issueHeader: (options && 'issueHeader' in options) ? options.issueHeader : 'issues',
    issueColor: (options && options.issueColor) || '#fee2e2',
  });
}

const FAMILY_LEDGER_SHEET_REGISTRY = Object.freeze({
  transactions: buildSheetConfig_('transactions', FAMILY_LEDGER_SHEET_NAMES.transactions, {
    edit: {
      width: 40,
      role: 'action',
      note: 'Click to open the Edit/Delete Transaction sidebar.',
      alignment: 'center',
      checkbox: true,
    },
    resource_name: {
      width: 180,
      role: 'system',
      note: 'Technical transaction resource name used by the client.',
      alignment: 'left',
    },
    transaction_date: {
      width: 95,
      role: 'readonly',
      note: 'Read-only transaction date.',
      alignment: 'left',
      numberFormat: 'yyyy-mm-dd',
      quickFilter: 'date',
      insertionOrder: true,
    },
    payee: {
      width: 280,
      role: 'editable',
      note: 'Editable payee. Applies to the whole transaction.',
      alignment: 'left',
      wrapStrategy: 'CLIP',
    },
    narration: {
      width: 200,
      role: 'editable',
      note: 'Editable narration. Normal text = transaction narration; italic = posting-specific narration.',
      alignment: 'left',
    },
    narration_source: {
      width: 95,
      role: 'system',
      note: 'Technical narration ownership marker used by the client.',
      alignment: 'left',
    },
    source_account_name: {
      width: 230,
      role: 'readonly',
      note: 'Read-only source account.',
      alignment: 'left',
      wrap: false,
      quickFilter: 'account',
    },
    destination_account_name: {
      width: 280,
      role: 'editable',
      note: 'Editable destination allocation account.',
      alignment: 'left',
      wrap: false,
      quickFilter: 'account',
      validation: 'account',
    },
    symbol: {
      width: 55,
      role: 'readonly',
      note: 'Read-only commodity symbol.',
      alignment: 'center',
    },
    amount: {
      width: 90,
      role: 'editable',
      note: 'Editable allocation amount. Lowering it creates a split for imported transactions.',
      alignment: 'right',
    },
    split_off_amount: {
      width: 95,
      role: 'action',
      note: 'Action field. Enter an amount to split, or x / - to delete a split row.',
      alignment: 'right',
    },
    issues: {
      width: 600,
      role: 'system',
      note: 'Derived ledger doctor issues merged by transaction.',
      alignment: 'left',
      wrap: false,
      wrapStrategy: 'OVERFLOW',
      formulaManaged: true,
    },
  }, {
    hiddenHeaders: ['resource_name', 'narration_source'],
    protectedHeaders: ['resource_name', 'transaction_date', 'source_account_name', 'symbol'],
  }),
  balances: buildSheetConfig_('balances', FAMILY_LEDGER_SHEET_NAMES.balances, {
    edit: {
      width: 50,
      role: 'action',
      note: 'Check to open the edit sidebar.',
      alignment: 'center',
      checkbox: true,
    },
    resource_name: {
      width: 220,
      role: 'system',
      note: 'Technical balance assertion resource name used by the client.',
      alignment: 'left',
    },
    assertion_date: {
      width: 95,
      role: 'readonly',
      note: 'Read-only assertion date.',
      alignment: 'left',
      numberFormat: 'yyyy-mm-dd',
      quickFilter: 'date',
      insertionOrder: true,
    },
    account: {
      width: 320,
      role: 'readonly',
      note: 'Read-only account.',
      alignment: 'left',
      wrap: false,
      quickFilter: 'account',
    },
    amount: {
      width: 110,
      role: 'readonly',
      note: 'Read-only asserted amount.',
      alignment: 'right',
    },
    symbol: {
      width: 55,
      role: 'readonly',
      note: 'Read-only commodity symbol.',
      alignment: 'center',
    },
    issues: {
      width: 600,
      role: 'system',
      note: 'Derived ledger doctor issues linked by balance assertion resource name.',
      alignment: 'left',
      wrap: false,
      wrapStrategy: 'OVERFLOW',
      formulaManaged: true,
    },
  }, {
    hiddenHeaders: ['resource_name'],
    protectedHeaders: ['resource_name'],
  }),
  accounts: buildSheetConfig_('accounts', FAMILY_LEDGER_SHEET_NAMES.accounts, {
    edit: {
      width: 40,
      role: 'action',
      note: 'Click to open the Edit/Delete Account sidebar.',
      alignment: 'center',
      checkbox: true,
    },
    resource_name: {
      width: 180,
      role: 'system',
      note: 'Technical resource name used by the client.',
      alignment: 'left',
    },
    account_name: {
      width: 320,
      role: 'editable',
      note: 'Visible account label used in the Transactions sheet.',
      alignment: 'left',
      wrap: false,
      quickFilter: 'account',
    },
    effective_start_date: {
      width: 95,
      role: 'readonly',
      note: 'Read-only account opening date.',
      alignment: 'left',
      numberFormat: 'yyyy-mm-dd',
    },
    effective_end_date: {
      width: 95,
      role: 'readonly',
      note: 'Read-only account closing date.',
      alignment: 'left',
      numberFormat: 'yyyy-mm-dd',
    },
    issues: {
      width: 600,
      role: 'system',
      note: 'Derived ledger doctor issues linked by account resource name.',
      alignment: 'left',
      wrap: false,
      wrapStrategy: 'OVERFLOW',
      formulaManaged: true,
    },
  }, {
    hiddenHeaders: ['resource_name'],
    protectedHeaders: ['resource_name', 'effective_start_date', 'effective_end_date'],
  }),
  commodities: buildSheetConfig_('commodities', FAMILY_LEDGER_SHEET_NAMES.commodities, {
    symbol: {
      width: 80,
      role: 'readonly',
      note: 'Commodity symbol.',
      alignment: 'left',
    },
  }, { issueHeader: null }),
  issues: buildSheetConfig_('issues', FAMILY_LEDGER_SHEET_NAMES.issues, {
    target: {
      width: 220,
      role: 'system',
      note: 'Technical resource name of the affected entity.',
      alignment: 'left',
    },
    navigate: {
      width: 300,
      role: 'readonly',
      note: 'Click to navigate to the affected row in the source sheet.',
      alignment: 'left',
      wrapStrategy: 'CLIP',
      formulaManaged: true,
    },
    issue_codes: {
      width: 200,
      role: 'readonly',
      note: 'Issue code identifiers.',
      alignment: 'left',
    },
    issues_text: {
      width: 500,
      role: 'readonly',
      note: 'Full issue descriptions.',
      alignment: 'left',
      wrap: false,
      wrapStrategy: 'OVERFLOW',
    },
  }, {
    issueHeader: null,
    hiddenHeaders: ['target'],
    protectedHeaders: ['target', 'navigate', 'issue_codes', 'issues_text'],
  }),
});
