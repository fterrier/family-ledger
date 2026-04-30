function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Family Ledger')
    .addItem('Set API Base URL', 'setFamilyLedgerBaseUrl')
    .addItem('Set API Token', 'setFamilyLedgerApiToken')
    .addItem('Show Current Settings', 'showFamilyLedgerSettings')
    .addItem('Test Connection', 'testFamilyLedgerConnection')
    .addSeparator()
    .addItem('Sync Accounts', 'syncFamilyLedgerAccounts')
    .addItem('Sync Transactions', 'syncFamilyLedgerTransactions')
    .addItem('Quick Filter', 'showQuickFilter')
    .addSeparator()
    .addItem('Push Active Transaction', 'pushActiveTransaction')
    .addSeparator()
    .addItem('Import data', 'showImportDialog')
    .addSeparator()
    .addItem('Reset Sheet Layouts', 'resetSheetLayouts')
    .addToUi();
}
