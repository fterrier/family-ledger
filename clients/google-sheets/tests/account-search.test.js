const test = require('node:test');
const assert = require('node:assert/strict');

const { loadCode } = require('./_harness');

test('searchAccountEntries_ matches ordered-character queries like foco', () => {
  const { sandbox } = loadCode();

  const matches = JSON.parse(JSON.stringify(sandbox.searchAccountEntries_([
    sandbox.buildAccountSearchEntry_({
      resource_name: 'accounts/coop',
      display_name: '[X] Family - Food - Coop',
    }),
    sandbox.buildAccountSearchEntry_({
      resource_name: 'accounts/coffee',
      display_name: '[X] Family - Coffee',
    }),
  ], 'foco', 8)));

  assert.equal(matches[0].resource_name, 'accounts/coop');
});

test('searchAccountEntries_ treats spaces as normal ordered characters', () => {
  const { sandbox } = loadCode();

  const matches = JSON.parse(JSON.stringify(sandbox.searchAccountEntries_([
    sandbox.buildAccountSearchEntry_({
      resource_name: 'accounts/coop',
      display_name: '[A] Family - Food - Coop',
    }),
  ], 'f fo c', 8)));

  assert.equal(matches[0].resource_name, 'accounts/coop');
});

test('searchAccountEntries_ preserves original order of matching accounts', () => {
  const { sandbox } = loadCode();

  const matches = JSON.parse(JSON.stringify(sandbox.searchAccountEntries_([
    sandbox.buildAccountSearchEntry_({
      resource_name: 'accounts/first',
      display_name: '[A] Family - Food - Coop',
    }),
    sandbox.buildAccountSearchEntry_({
      resource_name: 'accounts/second',
      display_name: '[A] Family - Finance - Core',
    }),
  ], 'ffc', 8)));

  assert.deepEqual(matches.map(function(entry) { return entry.resource_name; }), [
    'accounts/first',
    'accounts/second',
  ]);
});

test('searchAccountEntries_ returns all matching accounts without a hard cap', () => {
  const { sandbox } = loadCode();

  const entries = [];
  for (let index = 0; index < 12; index += 1) {
    entries.push(sandbox.buildAccountSearchEntry_({
      resource_name: 'accounts/match_' + index,
      display_name: '[X] Family - FoodWineHousehold - Coop ' + index,
    }));
  }
  const matches = sandbox.searchAccountEntries_(entries, 'ffoc');

  assert.equal(matches.length, 12);
});

test('isOrderedCharacterMatch_ rejects characters that do not appear in order', () => {
  const { sandbox } = loadCode();

  assert.equal(sandbox.isOrderedCharacterMatch_('fzc', '[A] Family - Food - Coop'), false);
});
