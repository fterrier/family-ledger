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

test('buildAccountFilterOptions_ generates sorted prefix and leaf entries', () => {
  const { sandbox } = loadCode();

  const result = sandbox.buildAccountFilterOptions_([
    '[A] Bank - Checking',
    '[A] Bank - Savings',
    '[X] Food',
  ]);

  const values = result.map(function(o) { return o.value; });
  assert.deepEqual(values, ['[A]', '[A] Bank', '[A] Bank - Checking', '[A] Bank - Savings', '[X]', '[X] Food']);

  const byValue = {};
  result.forEach(function(o) { byValue[o.value] = o; });
  assert.equal(byValue['[A]'].isPrefix, true, '[A] is a prefix');
  assert.equal(byValue['[A] Bank'].isPrefix, true, '[A] Bank is a prefix');
  assert.equal(byValue['[A] Bank - Checking'].isPrefix, false, 'leaf is not a prefix');
  assert.equal(byValue['[A] Bank - Savings'].isPrefix, false, 'leaf is not a prefix');
  assert.equal(byValue['[X]'].isPrefix, true, '[X] is a prefix');
  assert.equal(byValue['[X] Food'].isPrefix, false, 'real account is not a prefix');
});

test('filterAccountOptions_ always pins options with data-pinned regardless of query', () => {
  const { sandbox } = loadCode();

  const options = [
    { value: '', label: '— All accounts', dataset: { pinned: 'true' } },
    { value: '__blank__', label: '— Unassigned', dataset: { pinned: 'true' } },
    { value: '[A] Bank - Checking', label: '[A] Bank - Checking', dataset: {} },
    { value: '[A] Bank - Savings', label: '[A] Bank - Savings', dataset: {} },
  ];

  const result = sandbox.filterAccountOptions_('bankc', options);
  assert.equal(result[0].value, '', '— All accounts pinned first');
  assert.equal(result[1].value, '__blank__', '— Unassigned pinned second');
  assert.ok(result.some(function(o) { return o.value === '[A] Bank - Checking'; }), 'matching leaf included');
  assert.ok(!result.some(function(o) { return o.value === '[A] Bank - Savings'; }), 'non-matching leaf filtered out');
});

test('buildAccountFilterOptions_ marks account as leaf even when it is also a parent', () => {
  const { sandbox } = loadCode();

  const result = sandbox.buildAccountFilterOptions_([
    '[X] Food',
    '[X] Food - Restaurant',
  ]);

  const byValue = {};
  result.forEach(function(o) { byValue[o.value] = o; });
  assert.equal(byValue['[X] Food'].isPrefix, false, '[X] Food is a real account so isPrefix false');
  assert.equal(byValue['[X] Food - Restaurant'].isPrefix, false);
  assert.equal(byValue['[X]'].isPrefix, true);
});
