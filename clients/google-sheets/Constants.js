const FAMILY_LEDGER_SHEET_NAMES = {
  accounts: 'Accounts',
  transactions: 'Transactions',
  doctorTransactionIssues: 'DoctorTransactionIssues',
  doctorAccountIssues: 'DoctorAccountIssues',
};

const FAMILY_LEDGER_PAGE_SIZE = 1000;

const FAMILY_LEDGER_DOCTOR_ISSUES_HEADERS = ['target', 'issues_text'];

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
    issueHeader: (options && options.issueHeader) || 'issues',
    issueColor: (options && options.issueColor) || '#fee2e2',
  });
}

const FAMILY_LEDGER_SHEET_REGISTRY = Object.freeze({
  transactions: buildSheetConfig_('transactions', FAMILY_LEDGER_SHEET_NAMES.transactions, {
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
    },
    destination_account_name: {
      width: 280,
      role: 'editable',
      note: 'Editable destination allocation account.',
      alignment: 'left',
      wrap: false,
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
    status: {
      width: 90,
      role: 'system',
      note: 'dirty / saving / saved / error',
      alignment: 'center',
    },
    last_error: {
      width: 260,
      role: 'system',
      note: 'Most recent validation or save error.',
      alignment: 'left',
      wrap: true,
    },
    issues: {
      width: 420,
      role: 'system',
      note: 'Derived ledger doctor issues merged by transaction.',
      alignment: 'left',
      wrap: true,
    },
  }, {
    hiddenHeaders: ['resource_name', 'narration_source', 'last_error'],
    protectedHeaders: ['resource_name', 'transaction_date', 'source_account_name', 'symbol'],
  }),
  accounts: buildSheetConfig_('accounts', FAMILY_LEDGER_SHEET_NAMES.accounts, {
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
    },
    issues: {
      width: 420,
      role: 'system',
      note: 'Derived ledger doctor issues linked by account resource name.',
      alignment: 'left',
      wrap: true,
    },
  }, {
    hiddenHeaders: ['resource_name'],
    protectedHeaders: ['resource_name'],
  }),
});
