// Internal state (_api) mirrors the API entity shape:
// { name, transaction_date, payee, narration, postings: [{account, units, narration?}] }
//
// Context holds the account lookup maps needed for row conversion:
// { accountResourceToDisplayName, accountDisplayNameToResource }
class Transaction extends Entity {
  constructor(api, context) {
    super();
    this._api = api;
    this._context = context || {};
    this._span = null;
  }

  getName() { return this._api.name || null; }

  toRows_() {
    return flattenTransactionForSheet_(this._api, this._context.accountResourceToDisplayName || {});
  }

  validate() {
    if (!this._api.transaction_date) throw new Error('Transaction date is required.');
    if (!Array.isArray(this._api.postings)) throw new Error('Transaction must have postings.');
  }

  // Sidebar: set fields from either simple-mode keys (source_account, destination_account,
  // amount, symbol) or a raw postings array. applyEdit('amount') is a different path that
  // triggers a posting split on inline sheet edits.
  setFields(fields) {
    if ('transaction_date' in fields)
      this._api.transaction_date = normalizeEntityDate_(fields.transaction_date);
    if ('payee' in fields) this._api.payee = fields.payee || null;
    if ('narration' in fields) this._api.narration = fields.narration || null;
    if ('tags' in fields) {
      this._api.tags = Transaction.parseTagsString_(fields.tags);
    }
    if ('postings' in fields) {
      this._api.postings = fields.postings;
    } else if ('source_account' in fields) {
      const amount = parseFloat(fields.amount);
      const symbol = fields.symbol;
      this._api.postings = [{ account: fields.source_account, units: { amount: String(-amount), symbol: symbol } }];
      if (fields.destination_account) {
        this._api.postings.push({ account: fields.destination_account, units: { amount: String(amount), symbol: symbol } });
      }
    }
  }

  // Inline sheet edit — mutates this._api only, no sheet ops.
  // anchorRow: the sheet row number the user edited (used to locate the posting).
  applyEdit(header, value, oldValue, anchorRow) {
    if (header === 'payee') {
      this._api.payee = String(value || '').trim() || null;
      this._updateMask = 'payee';
      return;
    }

    if (header === 'tags') {
      this._api.tags = Transaction.parseTagsString_(value);
      this._updateMask = 'tags';
      return;
    }

    if (header === 'narration') {
      if (this._span === null || this._span.count <= 1) {
        this._api.narration = String(value || '').trim() || null;
        this._updateMask = 'narration';
        return;
      }
      if (this._hasCostPrice || hasPostingCostOrPrice_(this._api.postings)) {
        throw new Error('Transactions with complex postings (cost or price) cannot be edited here — please use the sidebar.');
      }
      const destOffset = anchorRow - this._span.start;
      const posting = this._api.postings[1 + destOffset];
      const normalizedValue = String(value ?? '').trim();
      const transactionNarration = this._api.narration || '';
      if (!normalizedValue || normalizedValue === transactionNarration) {
        posting.narration = null;
      } else {
        const isLastNull = posting.narration === null && this._api.postings.slice(1).every(function(p, i) {
          return i === destOffset || p.narration !== null;
        });
        if (isLastNull) {
          // No shared narration row will remain — blank the transaction narration so the
          // edited posting can carry its own without violating the invariant.
          this._api.narration = null;
        }
        posting.narration = normalizedValue;
      }
      this._updateMask = 'narration,postings';
      return;
    }

    if (this._hasCostPrice || hasPostingCostOrPrice_(this._api.postings)) {
      throw new Error('Transactions with complex postings (cost or price) cannot be edited here — please use the sidebar.');
    }

    this._updateMask = 'postings';

    if (header === 'destination_account_name') {
      const trimmedValue = normalizeOptionalSheetText_(value);
      const destOffset = anchorRow - this._span.start;
      if (!trimmedValue) {
        this._api.postings[1 + destOffset].account = null;
        return;
      }
      const account = this._context.accountDisplayNameToResource[trimmedValue];
      if (!account) throw new Error('Unknown account_name: ' + value);
      this._api.postings[1 + destOffset].account = account;
      return;
    }

    if (header === 'amount') {
      const newAmount = parseFloat(value);
      const oldAmount = parseFloat(oldValue);
      if (isNaN(oldAmount)) return;
      if (isNaN(newAmount)) throw new Error('Invalid amount — enter a valid number.');
      if (newAmount === oldAmount) return;

      const destOffset = anchorRow - this._span.start;
      const postingIndex = 1 + destOffset;
      const posting = this._api.postings[postingIndex];
      posting.units.amount = String(newAmount);
      this._api.postings.splice(postingIndex + 1, 0, {
        account: posting.account,
        units: { amount: String(oldAmount - newAmount), symbol: posting.units.symbol },
        narration: null,
      });
      this._rebalanceSource_();
      return;
    }

    if (header === 'split_off_amount') {
      const instruction = String(value ?? '').trim();
      if (!instruction) return;

      const destOffset = anchorRow - this._span.start;
      const postingIndex = 1 + destOffset;

      if (instruction === 'x' || instruction === 'X' || instruction === '-') {
        const destinations = this._api.postings.slice(1);
        if (destinations.length === 0) return;
        if (destinations.length === 1) {
          this._api.postings = [this._api.postings[0]];
          return;
        }
        const adjacentIndex = postingIndex > 1 ? postingIndex - 1 : postingIndex + 1;
        const adjacent = this._api.postings[adjacentIndex];
        adjacent.units.amount = String(
          parseFloat(adjacent.units.amount) + parseFloat(this._api.postings[postingIndex].units.amount)
        );
        if (destinations.length === 2) {
          // Going from 2 destinations → 1: promote a posting-specific narration to the
          // transaction level so the single remaining row shows the right narration.
          if (adjacent.narration) this._api.narration = adjacent.narration;
          adjacent.narration = null;
        }
        this._api.postings.splice(postingIndex, 1);
        return;
      }

      const splitAmount = parseFloat(instruction);
      const posting = this._api.postings[postingIndex];
      const originalAmount = parseFloat(posting.units.amount);
      if (splitAmount === originalAmount) {
        throw new Error('Split amount must differ from the row amount.');
      }
      posting.units.amount = String(originalAmount - splitAmount);
      this._api.postings.splice(postingIndex + 1, 0, {
        account: null,
        units: { amount: String(splitAmount), symbol: posting.units.symbol },
        narration: null,
      });
      this._rebalanceSource_();
      return;
    }
  }

  _rebalanceSource_() {
    const total = this._api.postings.slice(1).reduce(function(s, p) { return s + parseFloat(p.units.amount); }, 0);
    this._api.postings[0].units.amount = String(-total);
  }

  // — Static config —

  static get SHEET_KEY() { return 'transactions'; }
  static get RESOURCE_IDENTITY() { return { header: 'resource_name', multiRow: true }; }
  static get RESET_ON_SAVE_FIELDS() { return ['split_off_amount']; }
  static get API_RESOURCE_KEY() { return 'transaction'; }
  static get UPDATE_MASK() { return 'transaction_date,payee,narration,postings,tags'; }
  static get ENTITY_LABEL() { return 'transaction'; }

  static parseTagsString_(raw) {
    const s = String(raw || '').trim();
    return s ? s.split(',').map(function(t) { return t.trim(); }).filter(Boolean) : [];
  }

  static isEditableHeader(h) {
    return ['payee', 'narration', 'destination_account_name', 'amount', 'split_off_amount', 'tags', 'edit'].indexOf(h) !== -1;
  }

  getUpdateMask_() {
    return this._updateMask;
  }

  toApiPayload_() {
    return {
      transaction_date: this._api.transaction_date,
      payee: this._api.payee || null,
      narration: this._api.narration || null,
      postings: (this._api.postings || []).filter(function(p, i) { return i === 0 || p.account; }),
      tags: this._api.tags || [],
    };
  }

  // Null-account postings are stripped by toApiPayload_() before the API call; re-attach
  // them at their original positions so blank-destination rows remain visible in the sheet.
  updateFromApi_(apiResponse) {
    const original = this._api.postings || [];
    const nullsByRank = [];
    let rank = 0;
    for (let i = 1; i < original.length; i++) {
      if (original[i].account) {
        rank++;
      } else {
        nullsByRank.push({ rank: rank, posting: original[i] });
      }
    }
    this._api = apiResponse;
    if (nullsByRank.length === 0) return;
    const dests = this._api.postings.slice(1);
    const postings = [this._api.postings[0]];
    let nullIdx = 0;
    for (let i = 0; i <= dests.length; i++) {
      while (nullIdx < nullsByRank.length && nullsByRank[nullIdx].rank === i) {
        postings.push(nullsByRank[nullIdx++].posting);
      }
      if (i < dests.length) postings.push(dests[i]);
    }
    this._api.postings = postings;
  }

  static loadContext_() {
    return buildTransactionContext_(loadAccountOptions_());
  }

  static fromApi_(apiEntity, context) {
    return new Transaction(apiEntity || {}, context);
  }

  // Construct from sheet rows (inline edit path).
  // Validates rows and reconstructs the API representation via buildTransactionPatchPayload_.
  // Throws if rows are inconsistent or have unknown account names.
  static fromRows(rows, context, span) {
    const api = parseTransactionRowsToApi_(rows, (context || {}).accountDisplayNameToResource || {});
    const tx = new Transaction(api, context);
    tx._span = span || null;
    tx._hasCostPrice = rows.length > 0 && !!rows[0].hasCostPrice;
    return tx;
  }

  // Returns { mode, fields } where each field is self-contained with type, label, hint,
  // default, and selection-options. mode: 'simple' | 'advanced'. The server may return
  // 'advanced' even when 'simple' is requested (unclassifiable or multi-destination txn).
  // currentPostings: postings array passed by the client when toggling modes.
  static buildSidebarFields_(entityName, mode, currentPostings) {
    const allRaw = loadAccountOptions_();
    const toOpts = function(list) {
      return list.map(function(o) {
        return { value: o.resource_name, label: o.display_name, startDate: o.start_date || null, endDate: o.end_date || null };
      });
    };
    const allAccountOpts   = toOpts(allRaw);
    const allCommodityOpts = listCommodityOptions_().map(function(o) { return { value: o.symbol, label: o.symbol }; });

    const postingsField = function(postings) {
      return {
        key: 'postings', label: '', type: 'postings', required: true,
        default: postings,
        'account-options':   allAccountOpts,
        'commodity-options': allCommodityOpts,
      };
    };

    const baseTextFields = [
      { key: 'transaction_date', label: 'Date',      type: 'date',     required: true, hint: 'Required.' },
      { key: 'payee',            label: 'Payee',     type: 'text',                     hint: 'Optional.' },
      { key: 'narration',        label: 'Narration', type: 'textarea',                 hint: 'Optional.' },
    ];

    let postings = currentPostings || null;
    let transactionDefaults = {};
    if (entityName) {
      const transaction = apiFetchJson_('get', '/' + entityName);
      if (!currentPostings) postings = transaction.postings || [];
      transactionDefaults = {
        transaction_date: transaction.transaction_date || '',
        payee:    transaction.payee    || '',
        narration: transaction.narration || '',
        tags: (transaction.tags || []).join(','),
      };
    }

    const textFields = baseTextFields.map(function(f) {
      return Object.assign({}, f, { default: transactionDefaults[f.key] || null });
    });

    const tagsField = {
      key: 'tags', label: 'Tags', type: 'text',
      hint: 'Comma-separated tags, no spaces within a tag.',
      default: transactionDefaults.tags || null,
    };

    const sourceAccountField = { key: 'source_account', label: 'Source account', type: 'account-search', required: true, hint: 'Source account for this transaction.' };
    const destinationAccountField = {
      key: 'destination_account', label: 'Destination account', type: 'account-search',
      hint: 'Optional. Leave blank for a source-only transaction.',
    };
    const amountField = {
      key: 'amount', label: 'Amount', type: 'number', required: true,
      hint: 'Positive for expenses; negative for incoming money. Same sign convention as the sheet.',
    };
    const symbolField = { key: 'symbol', label: 'Symbol', type: 'select', required: true };

    const advancedReturn = function(ps) {
      return { mode: 'advanced', allowModeSwitch: true, fields: textFields.concat([postingsField(ps || []), tagsField]) };
    };
    const simpleReturn = function(extraFields) {
      return { mode: 'simple', allowModeSwitch: true, fields: textFields.concat(extraFields) };
    };

    if (mode === 'advanced') {
      return advancedReturn(postings);
    }

    if (postings !== null) {
      const accountResourceToDisplayName = {};
      allRaw.forEach(function(o) { accountResourceToDisplayName[o.resource_name] = o.display_name; });
      const groups = classifyTransactionGroups_({ postings: postings }, accountResourceToDisplayName);

      if (!groups || groups.length !== 1 || groups[0].hasCostPrice || groups[0].sourceIndex === null || groups[0].destinationIndexes.length > 1) {
        return advancedReturn(postings);
      }

      const src = postings[groups[0].sourceIndex];
      const dst = groups[0].destinationIndexes.length > 0 ? postings[groups[0].destinationIndexes[0]] : null;
      return simpleReturn([
        Object.assign({}, sourceAccountField, { 'selection-options': allAccountOpts, default: src.account }),
        Object.assign({}, destinationAccountField, { 'selection-options': allAccountOpts, default: dst ? dst.account : null }),
        Object.assign({}, amountField, { default: dst ? parseFloat(dst.units.amount) : -parseFloat(src.units.amount) }),
        Object.assign({}, symbolField, { 'selection-options': allCommodityOpts, default: src.units.symbol }),
        tagsField,
      ]);
    }

    // Add mode: simple form with configured shortlists
    const settings = getAllQuickAddSettings_();
    const sourceOpts = toOpts(allRaw.filter(function(o) { return settings.sourceAccounts.indexOf(o.resource_name) !== -1; }));
    const destOpts   = toOpts(allRaw.filter(function(o) { return settings.destinationAccounts.indexOf(o.resource_name) !== -1; }));
    const symOpts    = buildQuickAddSymbolOptions_(listCommodityOptions_(), settings.symbols)
                         .map(function(o) { return { value: o.symbol, label: o.symbol }; });
    return simpleReturn([
      Object.assign({}, sourceAccountField, { 'selection-options': sourceOpts, default: settings.defaultSourceAccount || null }),
      Object.assign({}, destinationAccountField, { 'selection-options': destOpts }),
      amountField,
      Object.assign({}, symbolField, { 'selection-options': symOpts, default: settings.defaultSymbol || null }),
      tagsField,
    ]);
  }

  static buildMultiSelectSummary_(rawRows) {
    const row = rawRows[0] || {};
    const payee = String(row.payee || '');
    const date = formatDisplayDate_(row.transaction_date);
    const amount = row.amount != null ? formatDisplayAmount_(row.amount) : '';
    const symbol = String(row.symbol || '');
    return [payee || '(no payee)', date, amount + ' ' + symbol].filter(Boolean).join(' | ');
  }

  static activateAfterCreate_(sheet, span) {
    managedSheet_(sheet, FAMILY_LEDGER_SHEET_REGISTRY.transactions).activateCell(span.start, 'payee');
  }

}

// Populate the entity registries after class is defined.
ENTITY_REGISTRY[FAMILY_LEDGER_SHEET_NAMES.transactions] = Transaction;
ENTITY_CLASS_REGISTRY[Transaction.SHEET_KEY] = Transaction;

// Build the context maps needed for row ↔ API conversion from an account option list.
function buildTransactionContext_(accountOptions) {
  const accountResourceToDisplayName = {};
  const accountDisplayNameToResource = {};
  (accountOptions || []).forEach(function(o) {
    accountResourceToDisplayName[o.resource_name] = o.display_name;
    accountDisplayNameToResource[o.display_name] = o.resource_name;
  });
  return { accountResourceToDisplayName: accountResourceToDisplayName, accountDisplayNameToResource: accountDisplayNameToResource };
}

// Inverse of flattenTransactionForSheet_: sheet rows → internal API representation.
// Thin wrapper around buildTransactionPatchPayload_ that adds the entity name.
function parseTransactionRowsToApi_(rows, accountDisplayNameToResource) {
  const payload = buildTransactionPatchPayload_(rows, accountDisplayNameToResource);
  const name = rows.length > 0 ? String(rows[0].resource_name || '').trim() || null : null;
  const tags = Transaction.parseTagsString_(rows.length > 0 ? rows[0].tags : '');
  return Object.assign({ name: name }, payload, { tags: tags });
}

// — Transaction-specific functions (moved from TransactionsSheet.js) —

function flattenTransactionForSheet_(transaction, accountResourceToDisplayName) {
  const groups = classifyTransactionGroups_(transaction, accountResourceToDisplayName);
  if (groups === null) return null;

  const transactionNarration = String(transaction.narration || '');
  const tagsText = (transaction.tags || []).join(', ');
  const lookup = accountResourceToDisplayName || {};

  if (groups.length === 0) {
    return [{
      resource_name: transaction.name,
      narration_source: 'txn',
      transaction_date: transaction.transaction_date,
      payee: transaction.payee || '',
      narration: transactionNarration,
      source_account_name: '',
      destination_account_name: '',
      amount: '',
      split_off_amount: '',
      symbol: '',
      tags: tagsText,
    }];
  }

  const rows = [];

  groups.forEach(function(group) {
    if (group.sourceIndex === null) {
      rows.push({
        resource_name: transaction.name,
        narration_source: 'txn',
        transaction_date: transaction.transaction_date,
        payee: transaction.payee || '',
        narration: transactionNarration,
        source_account_name: '',
        destination_account_name: '',
        amount: '',
        split_off_amount: '',
        symbol: group.symbol,
        tags: tagsText,
        hasCostPrice: group.hasCostPrice,
      });
      return;
    }

    const sourcePosting = transaction.postings[group.sourceIndex];
    const sourceAccountName = lookup[sourcePosting.account] || sourcePosting.account;
    const sourceWeight = postingWeight_(sourcePosting);
    const sourceAmount = parseFloat(sourceWeight.amount);

    let destSum = 0;
    group.destinationIndexes.forEach(function(destinationIndex) {
      const posting = transaction.postings[destinationIndex];
      const postingNarration = String(posting.narration || '');
      const weight = postingWeight_(posting);
      const amount = parseFloat(weight.amount);
      destSum += amount;
      rows.push({
        resource_name: transaction.name,
        narration_source: postingNarration ? 'post' : 'txn',
        transaction_date: transaction.transaction_date,
        payee: transaction.payee || '',
        narration: effectiveSheetNarration_(transactionNarration, postingNarration),
        source_account_name: sourceAccountName,
        destination_account_name: lookup[posting.account] || posting.account,
        amount: amount,
        split_off_amount: '',
        symbol: weight.symbol,
        tags: tagsText,
        hasCostPrice: group.hasCostPrice,
      });
    });

    const remainder = -(sourceAmount + destSum);
    if (Math.abs(remainder) > 1e-9) {
      rows.push({
        resource_name: transaction.name,
        narration_source: 'txn',
        transaction_date: transaction.transaction_date,
        payee: transaction.payee || '',
        narration: transactionNarration,
        source_account_name: sourceAccountName,
        destination_account_name: '',
        amount: remainder,
        split_off_amount: '',
        symbol: sourceWeight.symbol,
        tags: tagsText,
        hasCostPrice: group.hasCostPrice,
      });
    }
  });

  return rows;
}

// Returns the weight of a posting. Falls back to units when weight field is absent
// (older API responses or test fixtures that predate the weight field).
function postingWeight_(posting) {
  return posting.weight || posting.units;
}

function hasPostingCostOrPrice_(postings) {
  return !!(postings && postings.some(function(p) { return p.cost || p.price; }));
}

// Classify a transaction into display groups, one per weight symbol.
// Each group: { symbol, sourceIndex, destinationIndexes, hasCostPrice }
// sourceIndex is a posting array index (or null when ambiguous).
// Returns null for malformed input; [] when all postings are zero-weight.
function classifyTransactionGroups_(transaction, accountResourceToDisplayName) {
  if (!transaction || !Array.isArray(transaction.postings)) {
    return null;
  }

  const postings = transaction.postings;
  if (postings.length === 0) return [];
  const hasCostPrice = hasPostingCostOrPrice_(postings);

  // Drop zero-weight postings — they carry no economic content.
  const active = postings.map(function(p, i) {
    const w = postingWeight_(p);
    return { index: i, posting: p, weight: w, weightAmount: parseFloat(w.amount) };
  }).filter(function(item) {
    return item.weightAmount !== 0;
  });

  if (active.length === 0) return [];

  // Group by weight symbol, preserving first-seen order.
  const symbolOrder = [];
  const bySymbol = {};
  active.forEach(function(item) {
    const sym = item.weight.symbol;
    if (!bySymbol[sym]) { symbolOrder.push(sym); bySymbol[sym] = []; }
    bySymbol[sym].push(item);
  });

  return symbolOrder.map(function(sym) {
    const items = bySymbol[sym];
    const sourceIndex = items.length > 0 ? items[0].index : null;
    const destinationIndexes = items.slice(1).map(function(item) { return item.index; });

    return { symbol: sym, sourceIndex: sourceIndex, destinationIndexes: destinationIndexes, hasCostPrice: hasCostPrice };
  });
}

function buildTransactionPatchPayload_(rows, accountDisplayNameToResource) {
  const issues = [];
  const sourceAccountName = requireSingleNormalizedValue_(
    rows,
    'source_account_name',
    'source account',
    issues
  );
  const symbol = requireSingleNormalizedValue_(rows, 'symbol', 'symbol', issues);
  const transactionDate = requireSingleNormalizedValue_(
    rows,
    'transaction_date',
    'transaction date',
    issues,
    normalizeEntityDate_
  );
  const payee = readOptionalNormalizedValue_(rows, 'payee', 'payee', issues);
  const narration = inferTransactionNarrationFromGroupRows_(rows, issues);
  const isSplitTransaction = rows.length > 1;
  const sourceAccount = accountDisplayNameToResource[sourceAccountName];
  if (!sourceAccount) throw new Error('Unknown account_name: ' + sourceAccountName);
  const destinationRows = [];
  const amounts = [];

  rows.forEach(function(row, index) {
    const displayRow = row.__rowNumber || index + 2;
    const destinationAccountName = normalizeOptionalSheetText_(row.destination_account_name);

    const amount = row.amount;
    if (typeof amount !== 'number' || isNaN(amount)) {
      issues.push('Row ' + displayRow + ': invalid amount');
      return;
    }

    if (destinationAccountName) {
      const destinationAccount = accountDisplayNameToResource[destinationAccountName];
      if (!destinationAccount) throw new Error('Unknown account_name: ' + destinationAccountName);
      destinationRows.push({
        account: destinationAccount,
        amount: amount,
        narration: normalizePostingNarrationFromSheetRow_(row, narration, isSplitTransaction),
      });
    } else {
      destinationRows.push({ account: null, amount: amount, narration: null });
    }
    amounts.push(amount);
  });

  if (issues.length > 0) {
    throw new Error(issues.join('\n'));
  }

  const totalAmount = amounts.reduce(function(a, b) { return a + b; }, 0);
  const postings = [{
    account: sourceAccount,
    units: {
      amount: String(-totalAmount),
      symbol: symbol,
    },
  }];
  destinationRows.forEach(function(row) {
    postings.push({
      account: row.account,
      narration: row.narration,
      units: {
        amount: String(row.amount),
        symbol: symbol,
      },
    });
  });
  return {
    transaction_date: transactionDate,
    payee: payee,
    narration: narration,
    postings: postings,
  };
}

function requireSingleNormalizedValue_(rows, fieldName, label, issues, normalizer) {
  const values = rows.map(function(row) {
    const value = row[fieldName];
    return normalizer ? normalizer(value) : String(value || '').trim();
  });
  const distinct = uniqueNonBlankValues_(values);
  if (distinct.length === 0) {
    issues.push('Missing ' + label + ' across transaction rows.');
    return '';
  }
  if (distinct.length > 1) {
    issues.push('Inconsistent ' + label + ' across transaction rows.');
    return '';
  }
  return distinct[0];
}

function readOptionalNormalizedValue_(rows, fieldName, label, issues) {
  const values = rows.map(function(row) {
    return String(row[fieldName] || '').trim();
  });
  const distinct = uniqueNonBlankValues_(values);
  if (distinct.length > 1) {
    issues.push('Inconsistent ' + label + ' across transaction rows.');
    return null;
  }
  return distinct.length === 0 ? null : distinct[0];
}

function effectiveSheetNarration_(transactionNarration, postingNarration) {
  const explicitPostingNarration = String(postingNarration || '');
  if (explicitPostingNarration) {
    return explicitPostingNarration;
  }
  return String(transactionNarration || '');
}

function normalizeOptionalSheetText_(value) {
  const normalized = String(value || '').trim();
  return normalized ? normalized : null;
}

function inferTransactionNarrationFromGroupRows_(rows, issues) {
  const transactionRows = rows.filter(function(row) {
    return String(row.narration_source || 'txn').trim() !== 'post';
  });
  if (transactionRows.length === 0) {
    return null;  // all rows carry posting-specific narrations; transaction narration is blank
  }
  return normalizeOptionalSheetText_(transactionRows[0].narration);
}

function normalizePostingNarrationFromSheetRow_(row, transactionNarration, isSplitTransaction) {
  if (!isSplitTransaction) {
    return null;
  }
  const visibleNarration = normalizeOptionalSheetText_(row.narration);
  const sharedNarration = normalizeOptionalSheetText_(transactionNarration);
  if (visibleNarration === sharedNarration) {
    return null;
  }
  return visibleNarration;
}
