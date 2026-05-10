function onOpen() {
  const ui = SpreadsheetApp.getUi();
  const devMenu = ui.createMenu('Developer Settings')
    .addItem('Sync Ledger', 'syncLedger')
    .addItem('Push Active Transaction', 'pushActiveTransaction')
    .addItem('Reset Sheet Layouts', 'resetSheetLayouts')
    .addSeparator()
    .addItem('API Settings', 'showApiSettings')
    .addItem('Test Connection', 'testFamilyLedgerConnection');
  ui.createMenu('Family Ledger')
    .addItem('Quick Filter', 'showQuickFilter')
    .addItem('Quick Add Transaction', 'showQuickAddTransaction')
    .addSeparator()
    .addItem('Sheet Settings', 'showSheetSettings')
    .addItem('Import data', 'showImportDialog')
    .addSeparator()
    .addSubMenu(devMenu)
    .addToUi();
}
