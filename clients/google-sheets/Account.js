class Account extends Entity {
  constructor(api, context) {
    super();
    this._api = api;
    this._context = context || {};
    this._span = null;
  }

  getName() { return this._api.name || null; }

  toRows_() {
    return [{
      edit: false,
      resource_name: this._api.name || '',
      account_name: formatAccountDisplayName_(this._api.account_name || ''),
      issues: '',
    }];
  }

  toApiPayload_() {
    return { account_name: this._api.account_name };
  }

  validate() {
    if (!this._api.account_name) throw new Error('Account name is required.');
  }

  updateFromApi_(apiResponse) { this._api = apiResponse; }

  setFields(fields) {
    if ('account_name' in fields) {
      this._api.account_name = String(fields.account_name || '').trim() || null;
    }
  }

  static get SHEET_KEY() { return 'accounts'; }
  static get RESOURCE_IDENTITY() { return { header: 'resource_name', multiRow: false }; }
  static get API_RESOURCE_KEY() { return 'account'; }
  static get API_COLLECTION_PATH() { return 'accounts'; }
  static get UPDATE_MASK() { return 'account_name'; }
  static get ENTITY_LABEL() { return 'account'; }

  static isEditableHeader(h) { return h === 'edit'; }

  static loadContext_() { return {}; }

  static fromApi(apiEntity, context) {
    return new Account(apiEntity || {}, context);
  }

  static fromRows(rows, context, span) {
    const row = rows[0] || {};
    const api = {
      name: String(row.resource_name || '').trim() || null,
      account_name: null,
    };
    const instance = new Account(api, context || {});
    instance._span = span || null;
    return instance;
  }

  static buildSidebarFields_(entityName, _mode) {
    let defaults = {};
    if (entityName) {
      const apiEntity = apiFetchJson_('get', Account.apiPath_(entityName));
      defaults = { account_name: apiEntity.account_name || null };
    }
    return {
      mode: 'advanced',
      fields: [{
        key: 'account_name',
        label: 'Account name',
        type: 'text',
        required: true,
        hint: 'Canonical account name, e.g. Assets:Family:ZKB:Checking.',
        default: defaults.account_name || null,
      }],
    };
  }
}

ENTITY_REGISTRY[FAMILY_LEDGER_SHEET_NAMES.accounts] = Account;
ENTITY_CLASS_REGISTRY[Account.SHEET_KEY] = Account;
