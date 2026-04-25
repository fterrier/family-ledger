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
        PropertiesService: 'readonly',
        ScriptApp: 'readonly',
        SpreadsheetApp: 'readonly',
        UrlFetchApp: 'readonly',
        Utilities: 'readonly',
        console: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': [
        'error',
        {
          varsIgnorePattern:
            '^(onOpen|handleTransactionEdit|setFamilyLedgerBaseUrl|setFamilyLedgerApiToken|showFamilyLedgerSettings|testFamilyLedgerConnection|syncFamilyLedgerAccounts|syncFamilyLedgerTransactions|splitSelectedTransactionRow|normalizeActiveTransactionFields|regroupActiveTransaction|pushActiveTransaction|resetSheetLayouts|refreshTransactionIssuesFromDoctor_|applyDoctorIssuesToExistingSheet_|applyTransactionIssueHighlighting_)$',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
];
