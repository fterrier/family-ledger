class Commodity extends Entity {
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
      symbol: this._api.symbol || '',
    }];
  }

  toApiPayload_() {
    return {
      symbol: this._api.symbol,
      entity_metadata: this._api.entity_metadata || {},
    };
  }

  validate() {
    if (!this._api.symbol) throw new Error('Symbol is required.');
  }

  updateFromApi_(apiResponse) { this._api = apiResponse; }

  setFields(fields) {
    if ('symbol' in fields) {
      this._api.symbol = String(fields.symbol || '').trim() || null;
    }
    if ('entity_metadata' in fields) {
      try {
        this._api.entity_metadata = JSON.parse(fields.entity_metadata || '{}');
      } catch (_e) {
        this._api.entity_metadata = {};
      }
    }
  }

  static get SHEET_KEY() { return 'commodities'; }
  static get RESOURCE_IDENTITY() { return { header: 'resource_name', multiRow: false }; }
  static get API_RESOURCE_KEY() { return 'commodity'; }
  static get API_COLLECTION_PATH() { return 'commodities'; }
  static get UPDATE_MASK() { return 'symbol,entity_metadata'; }
  static get ENTITY_LABEL() { return 'commodity'; }

  static isEditableHeader(h) { return h === 'edit'; }

  static loadContext_() { return {}; }

  static fromApi(apiEntity, context) {
    return new Commodity(apiEntity || {}, context);
  }

  static fromRows(rows, context, span) {
    const row = rows[0] || {};
    const api = {
      name: String(row.resource_name || '').trim() || null,
      symbol: null,
      entity_metadata: {},
    };
    const instance = new Commodity(api, context || {});
    instance._span = span || null;
    return instance;
  }

  static buildSidebarFields_(entityName, _mode) {
    let defaults = { symbol: null, entity_metadata: '{}' };
    if (entityName) {
      const apiEntity = apiFetchJson_('get', Commodity.apiPath_(entityName));
      defaults = {
        symbol: apiEntity.symbol || null,
        entity_metadata: JSON.stringify(apiEntity.entity_metadata || {}, null, 2),
      };
    }
    return {
      mode: 'advanced',
      fields: [
        {
          key: 'symbol',
          label: 'Symbol',
          type: 'text',
          required: true,
          hint: 'Unique commodity symbol, e.g. CHF, USD, AAPL.',
          default: defaults.symbol,
        },
        {
          key: 'entity_metadata',
          label: 'Metadata',
          type: 'textarea',
          required: false,
          hint: 'JSON metadata (advanced).',
          default: defaults.entity_metadata,
        },
      ],
    };
  }
}

ENTITY_REGISTRY[FAMILY_LEDGER_SHEET_NAMES.commodities] = Commodity;
ENTITY_CLASS_REGISTRY[Commodity.SHEET_KEY] = Commodity;
