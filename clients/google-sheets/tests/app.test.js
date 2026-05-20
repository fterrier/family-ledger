const test = require('node:test');
const assert = require('node:assert/strict');

const { loadCode } = require('./_harness');

function makeUiRecorder() {
  const topLevelMenus = [];

  function createMenu(name) {
    const menu = {
      name,
      entries: [],
      addItem(label, handler) {
        menu.entries.push({ type: 'item', label, handler });
        return menu;
      },
      addSeparator() {
        menu.entries.push({ type: 'separator' });
        return menu;
      },
      addSubMenu(submenu) {
        menu.entries.push({ type: 'submenu', submenu });
        return menu;
      },
      addToUi() {
        topLevelMenus.push(menu);
        return menu;
      },
    };
    return menu;
  }

  return {
    topLevelMenus,
    ui: {
      createMenu,
    },
  };
}

test('onOpen adds Importer Settings to the Family Ledger menu', () => {
  const recorder = makeUiRecorder();
  const { sandbox } = loadCode({
    SpreadsheetApp: {
      getUi() {
        return recorder.ui;
      },
    },
  });

  sandbox.onOpen();

  assert.equal(recorder.topLevelMenus.length, 1);
  const familyLedgerMenu = recorder.topLevelMenus[0];
  const labels = familyLedgerMenu.entries
    .filter((entry) => entry.type === 'item')
    .map((entry) => entry.label);
  assert.deepEqual(labels, [
    'Quick Filter',
    'Add Transaction',
    'Sheet Settings',
    'Importer Settings',
    'Import data',
  ]);
});
