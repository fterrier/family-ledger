class Price extends Entity {
  constructor(api) {
    super();
    this._api = api;
    this._span = null;
  }

  getName() { return this._api.name || null; }

  toRows_() {
    return [{
      edit: false,
      resource_name: this._api.name || '',
      price_date: this._api.price_date || '',
      base_symbol: this._api.base_symbol || '',
      quote_amount: (this._api.quote && this._api.quote.amount) || '',
      quote_symbol: (this._api.quote && this._api.quote.symbol) || '',
    }];
  }

  toApiPayload_() {
    return {
      price_date: this._api.price_date,
      base_symbol: this._api.base_symbol,
      quote: this._api.quote,
    };
  }

  validate() {
    if (!this._api.price_date) throw new Error('Date is required.');
    if (!this._api.base_symbol) throw new Error('Base symbol is required.');
    if (!this._api.quote || !this._api.quote.amount) throw new Error('Quote amount is required.');
    if (!this._api.quote || !this._api.quote.symbol) throw new Error('Quote symbol is required.');
  }

  updateFromApi_(apiResponse) {
    this._api = apiResponse;
  }

  setFields(fields) {
    if ('price_date' in fields) this._api.price_date = String(fields.price_date || '').trim() || null;
    if ('base_symbol' in fields) this._api.base_symbol = fields.base_symbol || null;
    if ('quote_amount' in fields || 'quote_symbol' in fields) {
      this._api.quote = this._api.quote || {};
      if ('quote_amount' in fields) this._api.quote.amount = fields.quote_amount !== '' && fields.quote_amount != null ? String(fields.quote_amount) : null;
      if ('quote_symbol' in fields) this._api.quote.symbol = fields.quote_symbol || null;
    }
  }

  // — Static config —

  static get SHEET_KEY() { return 'prices'; }
  static get RESOURCE_IDENTITY() { return { header: 'resource_name', multiRow: false }; }
  static get API_RESOURCE_KEY() { return 'price'; }
  static get API_COLLECTION_PATH() { return 'prices'; }
  static get UPDATE_MASK() { return 'price_date,base_symbol,quote'; }
  static get ENTITY_LABEL() { return 'price'; }

  static isEditableHeader(h) { return h === 'edit'; }

  static loadContext_() {
    return {};
  }

  static fromApi(apiEntity) {
    return new Price(apiEntity || {});
  }

  static fromRows(rows, _context, span) {
    const row = rows[0] || {};
    const quoteAmountRaw = row.quote_amount;
    const quoteAmountVal = quoteAmountRaw !== '' && quoteAmountRaw != null ? String(quoteAmountRaw) : null;
    const api = {
      name: String(row.resource_name || '').trim() || null,
      price_date: String(row.price_date || '').trim() || null,
      base_symbol: String(row.base_symbol || '').trim() || null,
      quote: { amount: quoteAmountVal, symbol: String(row.quote_symbol || '').trim() || null },
    };
    const instance = new Price(api);
    instance._span = span || null;
    return instance;
  }

  static buildSidebarFields_(entityName, _mode) {
    const allSymbolOpts = listCommodityOptions_().map(function(o) { return { value: o.symbol, label: o.symbol }; });

    let defaults = {};
    if (entityName) {
      const apiEntity = apiFetchJson_('get', Price.apiPath_(entityName));
      defaults = {
        price_date: apiEntity.price_date || null,
        base_symbol: apiEntity.base_symbol || null,
        quote_amount: (apiEntity.quote && apiEntity.quote.amount) || null,
        quote_symbol: (apiEntity.quote && apiEntity.quote.symbol) || null,
      };
    }

    return {
      mode: 'advanced',
      fields: [
        { key: 'price_date',    label: 'Date',         type: 'date',   required: true, hint: 'Required.', default: defaults.price_date },
        { key: 'base_symbol',   label: 'Base symbol',  type: 'select', required: true, hint: 'Required.', default: defaults.base_symbol, 'selection-options': allSymbolOpts },
        { key: 'quote_amount',  label: 'Price',        type: 'number', required: true, hint: 'Required.', default: defaults.quote_amount },
        { key: 'quote_symbol',  label: 'Quote symbol', type: 'select', required: true, hint: 'Required.', default: defaults.quote_symbol, 'selection-options': allSymbolOpts },
      ],
    };
  }

  static activateAfterCreate_(sheet, span) {
    managedSheet_(sheet, FAMILY_LEDGER_SHEET_REGISTRY.prices).activateCell(span.start, 'base_symbol');
  }
}

ENTITY_REGISTRY[FAMILY_LEDGER_SHEET_NAMES.prices] = Price;
ENTITY_CLASS_REGISTRY[Price.SHEET_KEY] = Price;
