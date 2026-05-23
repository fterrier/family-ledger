function onOpen() {
  const ui = SpreadsheetApp.getUi();
  const devMenu = ui.createMenu('Developer Settings')
    .addItem('Sync Ledger', 'syncLedger')
    .addItem('Reset Sheet Layouts', 'resetSheetLayouts')
    .addSeparator()
    .addItem('API Settings', 'showApiSettings')
    .addItem('Test Connection', 'testFamilyLedgerConnection');
  ui.createMenu('Family Ledger')
    .addItem('Quick Filter', 'showQuickFilter')
    .addItem('Add Transaction', 'showAddTransaction')
    .addItem('Add Balance Assertion', 'showAddBalanceAssertion')
    .addItem('Add Account', 'showAddAccount')
    .addItem('Add Commodity', 'showAddCommodity')
    .addItem('Add Attachment', 'showAddAttachment')
    .addSeparator()
    .addItem('Sheet Settings', 'showSheetSettings')
    .addItem('Importer Settings', 'showImporterSettings')
    .addItem('Import data', 'showImportDialog')
    .addSeparator()
    .addSubMenu(devMenu)
    .addToUi();
}
