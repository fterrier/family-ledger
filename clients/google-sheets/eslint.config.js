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
        SpreadsheetApp: 'readonly',
        UrlFetchApp: 'readonly',
        Utilities: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': [
        'error',
        {
          varsIgnorePattern:
            '^(onOpen|setFamilyLedgerBaseUrl|setFamilyLedgerApiToken|showFamilyLedgerSettings|testFamilyLedgerConnection|syncFamilyLedgerAccounts|syncFamilyLedgerTransactions|pushActiveFamilyLedgerTransactionRow)$',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
];
