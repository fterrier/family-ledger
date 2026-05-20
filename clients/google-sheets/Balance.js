// Internal state (_api) mirrors the API entity shape:
// { name, assertion_date, account, amount: { amount, symbol } }
//
// Context holds the account lookup maps needed for row conversion:
// { accountResourceToDisplayName, accountDisplayNameToResource }
class Balance extends Entity {
  constructor(api, context) {
    super();
    this._api = api;
    this._context = context || {};
    this._span = null;
  }

  getName() { return this._api.name || null; }

  toRows_() {
    const displayName = (this._context.accountResourceToDisplayName || {})[this._api.account] || this._api.account || '';
    return [{
      resource_name: this._api.name || '',
      assertion_date: this._api.assertion_date || '',
      account: displayName,
      amount: (this._api.amount && this._api.amount.amount) || '',
      symbol: (this._api.amount && this._api.amount.symbol) || '',
      edit: false,
      issues: '',
    }];
  }

  toApiPayload_() {
    return {
      assertion_date: this._api.assertion_date,
      account: this._api.account,
      amount: this._api.amount,
    };
  }

  validate() {
    if (!this._api.assertion_date) throw new Error('Assertion date is required.');
    if (!this._api.account) throw new Error('Account is required.');
    if (!this._api.amount || !this._api.amount.amount) throw new Error('Amount is required.');
    if (!this._api.amount || !this._api.amount.symbol) throw new Error('Symbol is required.');
  }

  updateFromApi_(apiResponse) {
    this._api = apiResponse;
  }

  setFields(fields) {
    if ('assertion_date' in fields) this._api.assertion_date = String(fields.assertion_date || '').trim() || null;
    if ('account' in fields) this._api.account = fields.account || null;
    if ('amount' in fields || 'symbol' in fields) {
      this._api.amount = this._api.amount || {};
      if ('amount' in fields) this._api.amount.amount = fields.amount !== '' && fields.amount != null ? String(fields.amount) : null;
      if ('symbol' in fields) this._api.amount.symbol = fields.symbol || null;
    }
  }

  // — Static config —

  static get SHEET_KEY() { return 'balances'; }
  static get RESOURCE_IDENTITY() { return { header: 'resource_name', multiRow: false }; }
  static get API_RESOURCE_KEY() { return 'balance_assertion'; }
  static get API_COLLECTION_PATH() { return 'balance-assertions'; }
  static get UPDATE_MASK() { return 'assertion_date,account,amount'; }
  static get ENTITY_LABEL() { return 'balance assertion'; }

  static isEditableHeader(h) { return h === 'edit'; }
  // isActionHeader inherits the default from Entity (returns true for 'edit')

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
    return new Balance(apiEntity || {}, context);
  }

  static fromRows(rows, context, span) {
    const row = rows[0] || {};
    const displayName = String(row.account || '').trim();
    const account = ((context || {}).accountDisplayNameToResource || {})[displayName] || displayName || null;
    const amountRaw = row.amount;
    const amountVal = amountRaw !== '' && amountRaw != null ? String(amountRaw) : null;
    const api = {
      name: String(row.resource_name || '').trim() || null,
      assertion_date: String(row.assertion_date || '').trim() || null,
      account: account,
      amount: { amount: amountVal, symbol: String(row.symbol || '').trim() || null },
    };
    const instance = new Balance(api, context);
    instance._span = span || null;
    return instance;
  }

  // Always returns mode:'advanced'. entityName triggers an API GET for defaults.
  static buildSidebarFields_(entityName, _mode) {
    const allAccountOpts = loadAccountOptions_().map(function(o) {
      return { value: o.resource_name, label: o.display_name };
    });
    const allSymbolOpts = listCommodityOptions_().map(function(o) { return { value: o.symbol, label: o.symbol }; });

    let defaults = {};
    if (entityName) {
      const apiEntity = apiFetchJson_('get', Balance.apiPath_(entityName));
      defaults = {
        assertion_date: apiEntity.assertion_date || null,
        account: apiEntity.account || null,
        amount: (apiEntity.amount && apiEntity.amount.amount) || null,
        symbol: (apiEntity.amount && apiEntity.amount.symbol) || null,
      };
    }

    return {
      mode: 'advanced',
      fields: [
        { key: 'assertion_date', label: 'Date',    type: 'date',           required: true,  hint: 'Required.',          default: defaults.assertion_date || null },
        { key: 'account',        label: 'Account', type: 'account-search', required: true,  hint: 'Required.',          default: defaults.account || null, 'selection-options': allAccountOpts },
        { key: 'amount',         label: 'Amount',  type: 'number',         required: true,  hint: 'Required.',          default: defaults.amount || null },
        { key: 'symbol',         label: 'Symbol',  type: 'select',         required: true,  hint: 'Required.',          default: defaults.symbol || null, 'selection-options': allSymbolOpts },
      ],
    };
  }

  static writeToSheet_(sheet, existingSpan, rows) {
    return applyBalanceResponseToSheet_(sheet, existingSpan, rows);
  }

  static activateAfterCreate_(sheet, span) {
    managedSheet_(sheet, FAMILY_LEDGER_SHEET_REGISTRY.balances).activateCell(span.start, 'account');
  }
}

ENTITY_REGISTRY[FAMILY_LEDGER_SHEET_NAMES.balances] = Balance;
ENTITY_CLASS_REGISTRY[Balance.SHEET_KEY] = Balance;

// Scan all rows in the balances sheet; return the first row number where
// assertion_date strictly exceeds the given date, or the row after the last row.
function findInsertionRowForBalanceDate_(sheet, assertionDate) {
  const normalizedDate = String(assertionDate || '').trim();
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return 2;
  const rows = managedSheet_(sheet, FAMILY_LEDGER_SHEET_REGISTRY.balances)
    .getRows({ start: 2, count: lastRow - 1 }, ['assertion_date']);
  for (let i = 0; i < rows.length; i += 1) {
    const rowDate = String(rows[i].assertion_date || '').trim();
    if (rowDate && rowDate > normalizedDate) return i + 2;
  }
  return lastRow + 1;
}

// TODO: unify with applyTransactionResponseToSheet_ under Entity.js once patterns stabilize.
function applyBalanceResponseToSheet_(sheet, existingSpan, rows) {
  if (!rows || rows.length === 0) {
    if (existingSpan) resizeContiguousRows_(sheet, existingSpan, 0);
    return null;
  }
  let targetSpan;
  if (!existingSpan) {
    const insertionRow = findInsertionRowForBalanceDate_(sheet, rows[0].assertion_date);
    targetSpan = resizeContiguousRows_(sheet, { start: insertionRow, count: 0 }, 1);
  } else {
    targetSpan = existingSpan;
  }
  managedSheet_(sheet, FAMILY_LEDGER_SHEET_REGISTRY.balances).setRows(targetSpan, rows);
  ensureBalancesIssueFormulas_(sheet, targetSpan);
  return targetSpan;
}
