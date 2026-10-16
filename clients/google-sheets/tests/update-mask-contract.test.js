const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');

const { loadCode } = require('./_harness');

// Mirrors the server's *_UPDATE_FIELDS (src/family_ledger/services/*.py). The server
// rejects a PATCH whose update_mask is missing, empty or names any other field.
const SERVER_UPDATE_FIELDS = {
  Account: ['account_name', 'effective_start_date', 'effective_end_date', 'entity_metadata'],
  Balance: ['assertion_date', 'account', 'amount', 'entity_metadata'],
  Commodity: ['symbol', 'ticker', 'entity_metadata'],
  Price: ['price_date', 'base_symbol', 'quote', 'entity_metadata'],
  Attachment: ['account', 'attachment_date', 'original_filename', 'media_type', 'document_url', 'entity_metadata'],
  Transaction: ['transaction_date', 'payee', 'narration', 'tags', 'entity_metadata', 'import_metadata', 'postings'],
};

for (const [className, allowed] of Object.entries(SERVER_UPDATE_FIELDS)) {
  test(`${className}.UPDATE_MASK only names fields the server accepts`, () => {
    const { sandbox } = loadCode();
    const mask = vm.runInContext(className, sandbox).UPDATE_MASK;
    const fields = mask.split(',').map((f) => f.trim()).filter(Boolean);
    assert.ok(fields.length > 0, 'update_mask must not be empty');
    for (const field of fields) assert.ok(allowed.includes(field), `${className}: unknown field ${field}`);
  });
}
