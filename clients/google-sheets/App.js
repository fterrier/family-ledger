function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Family Ledger')
    .addItem('API Settings', 'showApiSettings')
    .addItem('Test Connection', 'testFamilyLedgerConnection')
    .addSeparator()
    .addItem('Sync Ledger', 'syncLedgerAndResetLayout')
    .addItem('Quick Filter', 'showQuickFilter')
    .addSeparator()
    .addItem('Push Active Transaction', 'pushActiveTransaction')
    .addSeparator()
    .addItem('Import data', 'showImportDialog')
    .addSeparator()
    .addItem('Reset Sheet Layouts', 'resetSheetLayouts')
    .addToUi();
}
