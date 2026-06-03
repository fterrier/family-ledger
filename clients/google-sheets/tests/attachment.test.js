const test = require('node:test');
const assert = require('node:assert/strict');

const { loadCode, makeRowStoreSheet_ } = require('./_harness');

function makeAttachmentApi(overrides) {
  return Object.assign({
    name: 'attachments/att_abc',
    attachment_date: '2026-01-15',
    account: 'accounts/zkb',
    original_filename: 'statement.pdf',
    document_url: null,
    status: 'stored',
    entity_metadata: {},
  }, overrides);
}

function getAttachment(sandbox) {
  return sandbox.ENTITY_REGISTRY['Attachments'];
}

function makeAttachmentSheet_(sandbox, rowStore, operations) {
  return makeRowStoreSheet_(sandbox, rowStore, operations, 'Attachments');
}

function makeContext(overrides) {
  return Object.assign({
    accountResourceToDisplayName: { 'accounts/zkb': '[A] Family - ZKB - Checking' },
    accountDisplayNameToResource: { '[A] Family - ZKB - Checking': 'accounts/zkb' },
  }, overrides);
}

// --- Attachment.fromApi / toApiPayload_ / validate ---

test('Attachment.fromApi produces correct _api shape', () => {
  const { sandbox } = loadCode();
  const a = getAttachment(sandbox).fromApi_(makeAttachmentApi());

  assert.equal(a.getName(), 'attachments/att_abc');
  assert.equal(a._api.attachment_date, '2026-01-15');
  assert.equal(a._api.account, 'accounts/zkb');
  assert.equal(a._api.original_filename, 'statement.pdf');
  assert.equal(a._api.status, 'stored');
});

test('Attachment.toApiPayload_ includes only the 4 editable fields', () => {
  const { sandbox } = loadCode();
  const a = getAttachment(sandbox).fromApi_(makeAttachmentApi({ document_url: 'https://example.com/doc' }));
  const payload = a.toApiPayload_();

  assert.equal(payload.account, 'accounts/zkb');
  assert.equal(payload.attachment_date, '2026-01-15');
  assert.equal(payload.original_filename, 'statement.pdf');
  assert.equal(payload.document_url, 'https://example.com/doc');
  assert.ok(!('name' in payload));
  assert.ok(!('edit' in payload));
  assert.ok(!('status' in payload));
  assert.ok(!('entity_metadata' in payload));
});

test('Attachment.validate throws when attachment_date is missing', () => {
  const { sandbox } = loadCode();
  const a = getAttachment(sandbox).fromApi_(makeAttachmentApi({ attachment_date: null }));
  assert.throws(function() { a.validate(); }, /date/i);
});

test('Attachment.validate throws when account is missing', () => {
  const { sandbox } = loadCode();
  const a = getAttachment(sandbox).fromApi_(makeAttachmentApi({ account: null }));
  assert.throws(function() { a.validate(); }, /account/i);
});

test('Attachment.validate throws when original_filename is missing', () => {
  const { sandbox } = loadCode();
  const a = getAttachment(sandbox).fromApi_(makeAttachmentApi({ original_filename: null }));
  assert.throws(function() { a.validate(); }, /filename/i);
});

// --- Attachment.toRows_ ---

test('Attachment.toRows_ writes plain filename when no document_url', () => {
  const { sandbox } = loadCode();
  const a = getAttachment(sandbox).fromApi_(makeAttachmentApi(), makeContext());
  const rows = a.toRows_();

  assert.equal(rows.length, 1);
  assert.equal(rows[0].resource_name, 'attachments/att_abc');
  assert.equal(rows[0].attachment_date, '2026-01-15');
  assert.equal(rows[0].original_filename, 'statement.pdf');
  assert.equal(rows[0].status, 'stored');
  assert.equal(rows[0].edit, false);
  assert.equal(rows[0].issues, '');
});

test('Attachment.toRows_ writes HYPERLINK formula when document_url is present', () => {
  const { sandbox } = loadCode();
  const a = getAttachment(sandbox).fromApi_(
    makeAttachmentApi({ document_url: 'https://docs.example.com/file.pdf' }),
    makeContext()
  );
  const rows = a.toRows_();

  assert.ok(rows[0].original_filename.startsWith('=HYPERLINK('), 'should be a HYPERLINK formula');
  assert.ok(rows[0].original_filename.includes('https://docs.example.com/file.pdf'));
  assert.ok(rows[0].original_filename.includes('statement.pdf'));
});

test('Attachment.toRows_ resolves account resource name to display name via context', () => {
  const { sandbox } = loadCode();
  const a = getAttachment(sandbox).fromApi_(makeAttachmentApi(), makeContext());
  const rows = a.toRows_();

  assert.equal(rows[0].account, '[A] Family - ZKB - Checking');
});

test('Attachment.toRows_ falls back to raw account name when not in context', () => {
  const { sandbox } = loadCode();
  const a = getAttachment(sandbox).fromApi_(makeAttachmentApi(), {});
  const rows = a.toRows_();

  assert.equal(rows[0].account, 'accounts/zkb');
});

// --- Attachment.fromRows ---

test('Attachment.fromRows sets _api.name from resource_name and resolves account from context', () => {
  const { sandbox } = loadCode();
  const rows = [{
    edit: false,
    resource_name: 'attachments/att_abc',
    attachment_date: '2026-01-15',
    account: '[A] Family - ZKB - Checking',
    original_filename: 'statement.pdf',
    status: 'stored',
    issues: '',
  }];
  const context = makeContext();
  const a = getAttachment(sandbox).fromRows(rows, context, { start: 2, count: 1 });

  assert.equal(a._api.name, 'attachments/att_abc');
  assert.equal(a._api.account, 'accounts/zkb');
  assert.equal(a._api.attachment_date, null);
  assert.equal(a._api.original_filename, null);
  assert.deepEqual(a._span, { start: 2, count: 1 });
});

// --- Attachment.buildSidebarFields_ ---

test('Attachment.buildSidebarFields_ returns mode:advanced with 4 fields and null defaults for add mode', () => {
  const { sandbox } = loadCode();
  sandbox.loadAccountOptions_ = function() { return []; };

  const result = getAttachment(sandbox).buildSidebarFields_(null, 'simple');

  assert.equal(result.mode, 'advanced');
  assert.equal(result.fields.length, 4);
  assert.equal(result.fields[0].key, 'attachment_date');
  assert.equal(result.fields[0].type, 'date');
  assert.equal(result.fields[0].required, true);
  assert.equal(result.fields[0].default, null);
  assert.equal(result.fields[1].key, 'account');
  assert.equal(result.fields[1].type, 'account-search');
  assert.equal(result.fields[2].key, 'original_filename');
  assert.equal(result.fields[2].type, 'text');
  assert.equal(result.fields[2].required, true);
  assert.equal(result.fields[3].key, 'document_url');
  assert.equal(result.fields[3].required, false);
});

test('Attachment.buildSidebarFields_ fetches fields from API for edit mode', () => {
  const { sandbox } = loadCode();
  sandbox.loadAccountOptions_ = function() { return []; };
  sandbox.apiFetchJson_ = function(method, path) {
    if (method === 'get' && path === '/attachments/att_abc') {
      return makeAttachmentApi({ document_url: 'https://docs.example.com/file.pdf' });
    }
    throw new Error('unexpected: ' + method + ' ' + path);
  };

  const result = getAttachment(sandbox).buildSidebarFields_('attachments/att_abc', 'advanced');

  assert.equal(result.fields[0].default, '2026-01-15');
  assert.equal(result.fields[1].default, 'accounts/zkb');
  assert.equal(result.fields[2].default, 'statement.pdf');
  assert.equal(result.fields[3].default, 'https://docs.example.com/file.pdf');
});

// --- submitEntity (add + edit) ---

test('submitEntity creates new attachment via POST and writes row to sheet', () => {
  const operations = [];
  const rowStore = new Map();
  const { sandbox } = loadCode({
    SpreadsheetApp: {
      getActiveSpreadsheet() { return { toast() {}, getSheetByName() { return null; }, setActiveSheet() {} }; },
    },
  });
  const sheet = makeAttachmentSheet_(sandbox, rowStore, operations);

  sandbox.loadAccountOptions_ = function() { return []; };
  sandbox.apiFetchJson_ = function(method, path, body) {
    if (method === 'post' && path === '/attachments') {
      return makeAttachmentApi({
        name: 'attachments/att_new',
        attachment_date: body.attachment.attachment_date,
        original_filename: body.attachment.original_filename,
        account: body.attachment.account,
      });
    }
    throw new Error('unexpected: ' + method + ' ' + path);
  };
  sandbox.getOrCreateSheet_ = function() { return sheet; };
  sandbox.refreshDoctorIssueSheets_ = function() {};

  sandbox.submitEntity(
    { classKey: 'attachments', name: null, span: null, context: null },
    { attachment_date: '2026-03-01', account: 'accounts/zkb', original_filename: 'receipt.pdf', document_url: '' }
  );

  const written = rowStore.get(2);
  assert.ok(written, 'row should be written to sheet');
  assert.equal(written.resource_name, 'attachments/att_new');
  assert.equal(written.original_filename, 'receipt.pdf');
  assert.equal(written.edit, false);
});

test('submitEntity edits existing attachment via PATCH with correct update_mask', () => {
  const operations = [];
  const rowStore = new Map([
    [2, {
      edit: false,
      resource_name: 'attachments/att_abc',
      attachment_date: '2026-01-15',
      account: '[A] Family - ZKB - Checking',
      original_filename: 'statement.pdf',
      status: 'stored',
      issues: '',
    }],
  ]);
  const { sandbox } = loadCode({
    SpreadsheetApp: {
      getActiveSpreadsheet() { return { toast() {}, getSheetByName() { return null; } }; },
    },
  });
  const sheet = makeAttachmentSheet_(sandbox, rowStore, operations);
  let patchBody = null;

  sandbox.loadAccountOptions_ = function() { return []; };
  sandbox.apiFetchJson_ = function(method, path, body) {
    if (method === 'patch' && path === '/attachments/att_abc') {
      patchBody = body;
      return makeAttachmentApi({
        original_filename: body.attachment.original_filename,
        document_url: body.attachment.document_url,
      });
    }
    throw new Error('unexpected: ' + method + ' ' + path);
  };
  sandbox.getOrCreateSheet_ = function() { return sheet; };
  sandbox.refreshDoctorIssueSheets_ = function() {};

  sandbox.submitEntity(
    { classKey: 'attachments', name: 'attachments/att_abc', span: { start: 2, count: 1 }, context: null },
    { attachment_date: '2026-01-15', account: 'accounts/zkb', original_filename: 'statement_v2.pdf', document_url: 'https://docs.example.com/file.pdf' }
  );

  assert.equal(patchBody.attachment.original_filename, 'statement_v2.pdf');
  assert.equal(patchBody.attachment.document_url, 'https://docs.example.com/file.pdf');
  assert.ok(!('status' in patchBody.attachment), 'status should not be in PATCH body');
  assert.equal(patchBody.update_mask, 'account,attachment_date,original_filename,document_url');

  const updated = rowStore.get(2);
  assert.ok(updated.original_filename.includes('statement_v2.pdf'), 'filename should appear in cell (as HYPERLINK formula since document_url is set)');
});
