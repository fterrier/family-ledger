const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: ['node_modules/**'],
  },
  js.configs.recommended,
  {
    files: ['Code.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...globals.es2022,
        BigInt: 'readonly',
        HtmlService: 'readonly',
        PropertiesService: 'readonly',
        ScriptApp: 'readonly',
        SpreadsheetApp: 'readonly',
        UrlFetchApp: 'readonly',
        Utilities: 'readonly',
        console: 'readonly',
        // Constants defined in Constants.js, shared across all script files.
        FAMILY_LEDGER_SHEET_NAMES: 'readonly',
        FAMILY_LEDGER_PAGE_SIZE: 'readonly',
        FAMILY_LEDGER_TRANSACTION_HEADERS: 'readonly',
        FAMILY_LEDGER_ACCOUNTS_HEADERS: 'readonly',
        FAMILY_LEDGER_DOCTOR_ISSUES_HEADERS: 'readonly',
        FAMILY_LEDGER_ACCOUNT_ROOT_MARKERS: 'readonly',
        FAMILY_LEDGER_TRANSACTION_COLUMN_LAYOUT: 'readonly',
        FAMILY_LEDGER_COLUMN_ROLE_COLORS: 'readonly',
        FAMILY_LEDGER_TRANSACTION_ISSUE_ROW_COLOR: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': [
        'error',
        {
          varsIgnorePattern:
            '^(onOpen|handleTransactionEdit|setFamilyLedgerBaseUrl|setFamilyLedgerApiToken|showFamilyLedgerSettings|testFamilyLedgerConnection|syncFamilyLedgerAccounts|syncFamilyLedgerTransactions|splitSelectedTransactionRow|normalizeActiveTransactionFields|regroupActiveTransaction|pushActiveTransaction|resetSheetLayouts|showImportDialog|getImportersForDialog|getAccountsForDialog|runImportFromDialog|refreshTransactionIssuesFromDoctor_|applyDoctorIssuesToExistingSheet_|applyTransactionIssueHighlighting_)$',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
];
