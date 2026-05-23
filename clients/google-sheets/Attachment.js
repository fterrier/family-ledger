class Attachment extends Entity {
  constructor(api, context) {
    super();
    this._api = api;
    this._context = context || {};
    this._span = null;
  }

  getName() { return this._api.name || null; }

  toRows_() {
    const displayName = (this._context.accountResourceToDisplayName || {})[this._api.account] || this._api.account || '';
    let filenameCell = this._api.original_filename || '';
    if (this._api.document_url) {
      const url = String(this._api.document_url).replace(/"/g, '""');
      const label = (this._api.original_filename || 'Open').replace(/"/g, '""');
      filenameCell = '=HYPERLINK("' + url + '","' + label + '")';
    }
    return [{
      edit: false,
      resource_name: this._api.name || '',
      attachment_date: this._api.attachment_date || '',
      account: displayName,
      original_filename: filenameCell,
      status: this._api.status || '',
      issues: '',
    }];
  }

  toApiPayload_() {
    return {
      account: this._api.account,
      attachment_date: this._api.attachment_date,
      original_filename: this._api.original_filename,
      document_url: this._api.document_url || null,
    };
  }

  validate() {
    if (!this._api.attachment_date) throw new Error('Attachment date is required.');
    if (!this._api.account) throw new Error('Account is required.');
    if (!this._api.original_filename) throw new Error('Filename is required.');
  }

  updateFromApi_(apiResponse) { this._api = apiResponse; }

  setFields(fields) {
    if ('attachment_date' in fields) this._api.attachment_date = String(fields.attachment_date || '').trim() || null;
    if ('account' in fields) this._api.account = fields.account || null;
    if ('original_filename' in fields) this._api.original_filename = String(fields.original_filename || '').trim() || null;
    if ('document_url' in fields) this._api.document_url = String(fields.document_url || '').trim() || null;
  }

  static get SHEET_KEY() { return 'attachments'; }
  static get RESOURCE_IDENTITY() { return { header: 'resource_name', multiRow: false }; }
  static get API_RESOURCE_KEY() { return 'attachment'; }
  static get API_COLLECTION_PATH() { return 'attachments'; }
  static get UPDATE_MASK() { return 'account,attachment_date,original_filename,document_url'; }
  static get ENTITY_LABEL() { return 'attachment'; }

  static isEditableHeader(h) { return h === 'edit'; }

  static loadContext_() {
    const opts = loadAccountOptions_();
    const accountResourceToDisplayName = {};
    const accountDisplayNameToResource = {};
    (opts || []).forEach(function(o) {
      accountResourceToDisplayName[o.resource_name] = o.display_name;
      accountDisplayNameToResource[o.display_name] = o.resource_name;
    });
    return { accountResourceToDisplayName: accountResourceToDisplayName, accountDisplayNameToResource: accountDisplayNameToResource };
  }

  static fromApi(apiEntity, context) {
    return new Attachment(apiEntity || {}, context);
  }

  static fromRows(rows, context, span) {
    const row = rows[0] || {};
    const displayName = String(row.account || '').trim();
    const account = ((context || {}).accountDisplayNameToResource || {})[displayName] || displayName || null;
    const api = {
      name: String(row.resource_name || '').trim() || null,
      attachment_date: null,
      account: account,
      original_filename: null,
      document_url: null,
      status: null,
    };
    const instance = new Attachment(api, context || {});
    instance._span = span || null;
    return instance;
  }

  static buildSidebarFields_(entityName, _mode) {
    const allAccountOpts = loadAccountOptions_().map(function(o) {
      return { value: o.resource_name, label: o.display_name };
    });
    let defaults = {};
    if (entityName) {
      const apiEntity = apiFetchJson_('get', Attachment.apiPath_(entityName));
      defaults = {
        attachment_date: apiEntity.attachment_date || null,
        account: apiEntity.account || null,
        original_filename: apiEntity.original_filename || null,
        document_url: apiEntity.document_url || null,
      };
    }
    return {
      mode: 'advanced',
      fields: [
        { key: 'attachment_date',  label: 'Date',         type: 'date',           required: true,  hint: 'Required.',                                  default: defaults.attachment_date  || null },
        { key: 'account',          label: 'Account',      type: 'account-search', required: true,  hint: 'Required.',                                  default: defaults.account          || null, 'selection-options': allAccountOpts },
        { key: 'original_filename',label: 'Filename',     type: 'text',           required: true,  hint: 'Required.',                                  default: defaults.original_filename|| null },
        { key: 'document_url',     label: 'Document URL', type: 'text',           required: false, hint: 'Optional link to the stored document.',      default: defaults.document_url     || null },
      ],
    };
  }

  static activateAfterCreate_(sheet, span) {
    managedSheet_(sheet, FAMILY_LEDGER_SHEET_REGISTRY.attachments).activateCell(span.start, 'original_filename');
  }
}

ENTITY_REGISTRY[FAMILY_LEDGER_SHEET_NAMES.attachments] = Attachment;
ENTITY_CLASS_REGISTRY[Attachment.SHEET_KEY] = Attachment;
