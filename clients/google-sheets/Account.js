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
      effective_start_date: this._api.effective_start_date || '',
      effective_end_date: this._api.effective_end_date || '',
      issues: '',
    }];
  }

  toApiPayload_() {
    return {
      account_name: this._api.account_name,
      effective_start_date: this._api.effective_start_date || null,
      effective_end_date: this._api.effective_end_date || null,
    };
  }

  validate() {
    if (!this._api.account_name) throw new Error('Account name is required.');
  }

  updateFromApi_(apiResponse) { this._api = apiResponse; }

  setFields(fields) {
    if ('account_name' in fields) {
      this._api.account_name = String(fields.account_name || '').trim() || null;
    }
    if ('effective_start_date' in fields) {
      this._api.effective_start_date = String(fields.effective_start_date || '').trim() || null;
    }
    if ('effective_end_date' in fields) {
      this._api.effective_end_date = String(fields.effective_end_date || '').trim() || null;
    }
  }

  static get SHEET_KEY() { return 'accounts'; }
  static get RESOURCE_IDENTITY() { return { header: 'resource_name', multiRow: false }; }
  static get API_RESOURCE_KEY() { return 'account'; }
  static get API_COLLECTION_PATH() { return 'accounts'; }
  static get UPDATE_MASK() { return 'account_name,effective_start_date,effective_end_date'; }
  static get ENTITY_LABEL() { return 'account'; }

  static isEditableHeader(h) { return h === 'edit'; }

  static loadContext_() { return {}; }

  static afterSheetWrite_() {
    invalidateAccountOptionsCache_();
  }

  static fromApi_(apiEntity, context) {
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

  static buildMultiSelectSummary_(rawRows) {
    return String((rawRows[0] || {}).account_name || '');
  }

  static buildSidebarFields_(entityName, _mode) {
    let defaults = {};
    if (entityName) {
      const entity = Account.loadFromApi(entityName);
      defaults = {
        account_name: entity._api.account_name || null,
        effective_start_date: entity._api.effective_start_date || null,
        effective_end_date: entity._api.effective_end_date || null,
      };
    }
    return {
      mode: 'advanced',
      fields: [
        {
          key: 'account_name',
          label: 'Account name',
          type: 'text',
          required: true,
          hint: 'Canonical account name, e.g. Assets:Family:ZKB:Checking.',
          default: defaults.account_name || null,
        },
        {
          key: 'effective_start_date',
          label: 'Opening date',
          type: 'date',
          required: false,
          hint: 'Date when the account was opened.',
          default: defaults.effective_start_date || null,
        },
        {
          key: 'effective_end_date',
          label: 'Closing date',
          type: 'date',
          required: false,
          hint: 'Date when the account was closed (optional).',
          default: defaults.effective_end_date || null,
        },
      ],
    };
  }
}

ENTITY_REGISTRY[FAMILY_LEDGER_SHEET_NAMES.accounts] = Account;
ENTITY_CLASS_REGISTRY[Account.SHEET_KEY] = Account;
