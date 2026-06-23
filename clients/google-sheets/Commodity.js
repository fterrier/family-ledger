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
      ticker: this._api.ticker || '',
    }];
  }

  toApiPayload_() {
    return {
      symbol: this._api.symbol,
      ticker: this._api.ticker || null,
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
    if ('ticker' in fields) {
      this._api.ticker = String(fields.ticker || '').trim() || null;
    }
  }

  static get SHEET_KEY() { return 'commodities'; }
  static get RESOURCE_IDENTITY() { return { header: 'resource_name', multiRow: false }; }
  static get API_RESOURCE_KEY() { return 'commodity'; }
  static get API_COLLECTION_PATH() { return 'commodities'; }
  static get UPDATE_MASK() { return 'symbol,ticker'; }
  static get ENTITY_LABEL() { return 'commodity'; }

  static isEditableHeader(h) { return h === 'edit'; }

  static loadContext_() { return {}; }

  static fromApi_(apiEntity, context) {
    return new Commodity(apiEntity || {}, context);
  }

  static fromRows(rows, context, span) {
    const row = rows[0] || {};
    const api = {
      name: String(row.resource_name || '').trim() || null,
      symbol: null,
      ticker: String(row.ticker || '').trim() || null,
    };
    const instance = new Commodity(api, context || {});
    instance._span = span || null;
    return instance;
  }

  static buildMultiSelectSummary_(rawRows) {
    const row = rawRows[0] || {};
    const symbol = String(row.symbol || '');
    const ticker = String(row.ticker || '');
    return ticker ? symbol + ' (' + ticker + ')' : symbol;
  }

  static buildSidebarFields_(entityName, _mode) {
    let defaults = { symbol: null, ticker: null };
    if (entityName) {
      const entity = Commodity.loadFromApi(entityName);
      defaults = {
        symbol: entity._api.symbol || null,
        ticker: entity._api.ticker || null,
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
          key: 'ticker',
          label: 'Ticker',
          type: 'text',
          required: false,
          hint: 'Market ticker used to fetch prices, e.g. NESN.SW, USDCHF=X.',
          default: defaults.ticker,
        },
      ],
    };
  }
}

ENTITY_REGISTRY[FAMILY_LEDGER_SHEET_NAMES.commodities] = Commodity;
ENTITY_CLASS_REGISTRY[Commodity.SHEET_KEY] = Commodity;
