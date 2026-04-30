const test = require('node:test');
const assert = require('node:assert/strict');

const { loadCode } = require('./_harness');

test('formatAccountDisplayName_ shortens canonical account names with root markers', () => {
  const { sandbox } = loadCode();

  assert.equal(sandbox.formatAccountDisplayName_('Assets:Bank:Checking'), '[A] Bank - Checking');
  assert.equal(sandbox.formatAccountDisplayName_('Expenses:Food'), '[X] Food');
  assert.equal(sandbox.formatAccountDisplayName_('Income:Salary'), '[I] Salary');
});

test('buildAccountDisplayEntries_ produces display labels for account resources', () => {
  const { sandbox } = loadCode();

  const entries = sandbox.buildAccountDisplayEntries_([
    { name: 'accounts/checking', account_name: 'Assets:Bank:Checking' },
    { name: 'accounts/food', account_name: 'Expenses:Food' },
  ]);

  assert.deepEqual(JSON.parse(JSON.stringify(entries)), [
    {
      name: 'accounts/checking',
      account_name: 'Assets:Bank:Checking',
      display_name: '[A] Bank - Checking',
    },
    {
      name: 'accounts/food',
      account_name: 'Expenses:Food',
      display_name: '[X] Food',
    },
  ]);
});
