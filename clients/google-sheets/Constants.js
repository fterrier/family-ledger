const FAMILY_LEDGER_SHEET_NAMES = {
  accounts: 'Accounts',
  transactions: 'Transactions',
  doctorTransactionIssues: 'DoctorTransactionIssues',
  doctorAccountIssues: 'DoctorAccountIssues',
};

const FAMILY_LEDGER_PAGE_SIZE = 1000;

const FAMILY_LEDGER_TRANSACTION_HEADERS = [
  'transaction_name',
  'transaction_date',
  'payee',
  'narration',
  'source_account_name',
  'destination_account_name',
  'symbol',
  'amount',
  'split_off_amount',
  'status',
  'last_error',
  'issues',
];

const FAMILY_LEDGER_ACCOUNTS_HEADERS = ['account_name', 'name', 'issues'];

const FAMILY_LEDGER_DOCTOR_ISSUES_HEADERS = ['target', 'issues_text'];

const FAMILY_LEDGER_ACCOUNT_ROOT_MARKERS = {
  Assets: '[A]',
  Liabilities: '[L]',
  Expenses: '[X]',
  Income: '[I]',
  Equity: '[Q]',
};

const FAMILY_LEDGER_TRANSACTION_COLUMN_LAYOUT = {
  transaction_date: { width: 95, role: 'readonly', note: 'Read-only transaction date.' },
  payee: { width: 280, role: 'editable', note: 'Editable payee. Applies to the whole transaction.' },
  narration: { width: 200, role: 'editable', note: 'Editable narration. Applies to the whole transaction.' },
  source_account_name: { width: 230, role: 'readonly', note: 'Read-only source account.' },
  destination_account_name: {
    width: 280,
    role: 'editable',
    note: 'Editable destination allocation account.',
  },
  symbol: { width: 55, role: 'readonly', note: 'Read-only commodity symbol.' },
  amount: {
    width: 90,
    role: 'editable',
    note: 'Editable allocation amount. Lowering it creates a split for imported transactions.',
  },
  split_off_amount: {
    width: 95,
    role: 'action',
    note: 'Action field. Enter an amount to split, or x / - to delete a split row.',
  },
  status: { width: 90, role: 'system', note: 'dirty / saving / saved / error' },
  issues: { width: 420, role: 'system', note: 'Derived ledger doctor issues merged by transaction.' },
  last_error: { width: 260, role: 'system', note: 'Most recent validation or save error.' },
};

const FAMILY_LEDGER_COLUMN_ROLE_COLORS = {
  header: {
    readonly: '#d1d5db',
    editable: '#dbeafe',
    action: '#fde68a',
    system: '#e5e7eb',
  },
  body: {
    readonly: '#f3f4f6',
    editable: '#ffffff',
    action: '#fffbeb',
    system: '#f9fafb',
  },
};

const FAMILY_LEDGER_TRANSACTION_ISSUE_ROW_COLOR = '#fee2e2';
