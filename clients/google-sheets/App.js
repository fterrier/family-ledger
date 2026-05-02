function onOpen() {
  const ui = SpreadsheetApp.getUi();
  const devMenu = ui.createMenu('Developer Settings')
    .addItem('Sync Ledger', 'syncLedgerAndResetLayout')
    .addItem('Push Active Transaction', 'pushActiveTransaction')
    .addItem('Reset Sheet Layouts', 'resetSheetLayouts')
    .addSeparator()
    .addItem('API Settings', 'showApiSettings')
    .addItem('Test Connection', 'testFamilyLedgerConnection');
  ui.createMenu('Family Ledger')
    .addItem('Quick Filter', 'showQuickFilter')
    .addSeparator()
    .addItem('Import data', 'showImportDialog')
    .addSeparator()
    .addSubMenu(devMenu)
    .addToUi();
}
