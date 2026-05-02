const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: ['node_modules/**', 'eslint.config.js'],
  },
  js.configs.recommended,
  {
    files: ['*.js'],
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
        FAMILY_LEDGER_SHEET_REGISTRY: 'readonly',
        FAMILY_LEDGER_PAGE_SIZE: 'readonly',
        FAMILY_LEDGER_DOCTOR_ISSUES_HEADERS: 'readonly',
        FAMILY_LEDGER_ACCOUNT_ROOT_MARKERS: 'readonly',
        FAMILY_LEDGER_HEADER_ROLE_COLORS: 'readonly',
      },
    },
    rules: {
      'no-undef': 'off',
      'no-redeclare': 'off',
      'no-unused-vars': 'off',
    },
  },
];
