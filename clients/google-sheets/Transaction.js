// Internal state (_api) mirrors the API entity shape:
// { name, update_time, transaction_date, payee, narration, postings: [{account, units, narration?}] }
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
  // amount, symbol) or a raw postings array.
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
      // Every transaction has at least 2 postings, both fully specified — no special
      // casing for "the source posting". destination_account is either a real account
      // or left blank (accountless — categorize later); either way the destination gets
      // the user's amount verbatim, and the source's is derived from that same stored
      // string via a plain sign flip (no parseFloat — can't lose precision, unlike
      // summing across several rows, which is why the sheet's multi-row reconstruction
      // still omits units and leaves that to the server).
      const destination = {
        account: fields.destination_account || null,
        units: { amount: String(fields.amount), symbol: fields.symbol },
      };
      const source = {
        account: fields.source_account,
        units: { amount: negateAmountString_(destination.units.amount), symbol: fields.symbol },
      };
      this._api.postings = [source, destination];
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

    if (header === 'split_off_amount') {
      const instruction = String(value ?? '').trim();
      if (!instruction) return;

      const destOffset = anchorRow - this._span.start;
      const postingIndex = 1 + destOffset;

      if (instruction === 'x' || instruction === 'X' || instruction === '-') {
        this._pendingServerOp = {
          verb: 'unsplit',
          body: { posting_index: postingIndex, update_time: this._api.update_time },
        };
        return;
      }

      if (!isDecimalAmountString_(instruction)) {
        throw new Error('Invalid split amount — enter a valid number.');
      }
      this._pendingServerOp = {
        verb: 'split',
        body: { posting_index: postingIndex, split_off_amount: instruction, update_time: this._api.update_time },
      };
      return;
    }
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
    return ['payee', 'narration', 'destination_account_name', 'split_off_amount', 'tags', 'edit'].indexOf(h) !== -1;
  }

  getUpdateMask_() {
    return this._updateMask;
  }

  toApiPayload_() {
    return {
      transaction_date: this._api.transaction_date,
      payee: this._api.payee || null,
      narration: this._api.narration || null,
      postings: this._api.postings || [],
      tags: this._api.tags || [],
    };
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
    tx._hasCostPrice = rows.length > 0 && !!rows[0].has_cost_price;
    return tx;
  }

  // Returns { mode, fields } where each field is self-contained with type, label, hint,
  // default, and selection-options. mode: 'simple' | 'advanced'. The server may return
  // 'advanced' even when 'simple' is requested (unclassifiable or multi-destination txn).
  // Reads straight off this._api — Sidebar.js has already hydrated it (via loadFromApi for
  // a first-load edit, or setFields(fieldValues) for a mode-toggle round trip) before
  // calling this, so no separate "currentPostings" input or live GET is needed here.
  buildSidebarFields_(mode) {
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

    const postings = this._api.postings || null;
    const transactionDefaults = {
      transaction_date: this._api.transaction_date || '',
      payee:    this._api.payee    || '',
      narration: this._api.narration || '',
      tags: (this._api.tags || []).join(','),
    };

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
      hint: 'Optional. Leave blank to categorize later.',
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

      // The server always balance-fills any gap, so a real 1-symbol group always has
      // exactly one destination posting — never zero. A shape other than that falls
      // back to the advanced editor rather than assuming.
      if (!groups || groups.length !== 1 || groups[0].hasCostPrice || groups[0].destinationIndexes.length !== 1) {
        return advancedReturn(postings);
      }

      const src = postings[groups[0].sourceIndex];
      const dst = postings[groups[0].destinationIndexes[0]];
      return simpleReturn([
        Object.assign({}, sourceAccountField, { 'selection-options': allAccountOpts, default: src.account }),
        Object.assign({}, destinationAccountField, { 'selection-options': allAccountOpts, default: dst.account }),
        Object.assign({}, amountField, { default: dst.units.amount }),
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

  static buildBulkActions_(count) {
    if (count !== 2) return [];
    return [{ label: 'Merge', serverFn: 'mergeTransactions', confirm: 'Merge these ' + count + ' transactions? This cannot be undone.' }];
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
// Thin wrapper around buildTransactionPatchPayload_ that adds the entity name and
// update_time (both hidden-column values, identical across every row of the same
// transaction since they're populated together at render time — read from the first row).
function parseTransactionRowsToApi_(rows, accountDisplayNameToResource) {
  const payload = buildTransactionPatchPayload_(rows, accountDisplayNameToResource);
  const name = rows.length > 0 ? String(rows[0].resource_name || '').trim() || null : null;
  const tags = Transaction.parseTagsString_(rows.length > 0 ? rows[0].tags : '');
  const updateTime = rows.length > 0 && typeof rows[0].update_time === 'number' ? rows[0].update_time : null;
  return Object.assign({ name: name, update_time: updateTime }, payload, { tags: tags });
}

// — Transaction-specific functions (moved from TransactionsSheet.js) —

// A row with no real destination posting to show — used for the "no groups at all" and
// "source with no destination in this symbol" cases, which only differ in which of
// source_account_name/symbol/has_cost_price they know.
function blankDestinationRow_(transaction, transactionNarration, tagsText, fields) {
  return Object.assign({
    resource_name: transaction.name,
    update_time: transaction.update_time,
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
  }, fields);
}

function flattenTransactionForSheet_(transaction, accountResourceToDisplayName) {
  const groups = classifyTransactionGroups_(transaction, accountResourceToDisplayName);
  if (groups === null) return null;

  const transactionNarration = String(transaction.narration || '');
  const tagsText = (transaction.tags || []).join(', ');
  const lookup = accountResourceToDisplayName || {};

  if (groups.length === 0) {
    return [blankDestinationRow_(transaction, transactionNarration, tagsText, {})];
  }

  const rows = [];

  groups.forEach(function(group) {
    const sourcePosting = transaction.postings[group.sourceIndex];
    const sourceAccountName = lookup[sourcePosting.account] || sourcePosting.account;

    // A weight-symbol group can end up with a source and no destination — e.g. a
    // near-zero residual left within tolerance, in a symbol nothing else in the
    // transaction shares. There's no destination posting to show an amount from, so
    // render a blank-destination row rather than fail rendering the whole sheet over it.
    if (group.destinationIndexes.length === 0) {
      rows.push(blankDestinationRow_(transaction, transactionNarration, tagsText, {
        source_account_name: sourceAccountName,
        symbol: group.symbol,
        has_cost_price: group.hasCostPrice,
      }));
      return;
    }

    group.destinationIndexes.forEach(function(destinationIndex) {
      const posting = transaction.postings[destinationIndex];
      const postingNarration = String(posting.narration || '');
      const weight = postingWeight_(posting);
      rows.push({
        resource_name: transaction.name,
        update_time: transaction.update_time,
        narration_source: postingNarration ? 'post' : 'txn',
        transaction_date: transaction.transaction_date,
        payee: transaction.payee || '',
        narration: effectiveSheetNarration_(transactionNarration, postingNarration),
        source_account_name: sourceAccountName,
        destination_account_name: lookup[posting.account] || posting.account,
        // Written verbatim as a string — Sheets parses a numeric-looking string into a
        // real number on write (same as typing it in), respecting the amount column's
        // own numberFormat. No client-side float conversion needed.
        amount: weight.amount,
        split_off_amount: '',
        symbol: weight.symbol,
        tags: tagsText,
        has_cost_price: group.hasCostPrice,
      });
    });
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
// sourceIndex is the first-seen posting's array index for that symbol (always a real
// index — every symbol in the result has at least one posting by construction, so this
// is never ambiguous). Zero-weight postings are kept and classified like any other (no
// special-casing for display purposes). Returns null for malformed input; [] when there
// are no postings at all.
function classifyTransactionGroups_(transaction, accountResourceToDisplayName) {
  if (!transaction || !Array.isArray(transaction.postings)) {
    return null;
  }

  const postings = transaction.postings;
  if (postings.length === 0) return [];
  const hasCostPrice = hasPostingCostOrPrice_(postings);

  const active = postings.map(function(p, i) {
    return { index: i, posting: p, weight: postingWeight_(p) };
  });

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
    const destinationIndexes = items.slice(1).map(function(item) { return item.index; });

    return { symbol: sym, sourceIndex: items[0].index, destinationIndexes: destinationIndexes, hasCostPrice: hasCostPrice };
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
  });

  if (issues.length > 0) {
    throw new Error(issues.join('\n'));
  }

  // The source's own amount is never computed client-side — its units are omitted
  // entirely and the server interpolates it from the (verbatim, unmodified)
  // destination amounts below (see ADR 0006's normalization boundary).
  const postings = [{ account: sourceAccount }];
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

// Flips an amount string's sign by editing the string itself — no parseFloat/toString
// round-trip, so exact decimal input is preserved verbatim.
function negateAmountString_(amountStr) {
  const trimmed = String(amountStr || '').trim();
  return trimmed.charAt(0) === '-' ? trimmed.slice(1) : '-' + trimmed;
}

// Validates a user-typed amount is a plain decimal number — no parseFloat, so this
// never risks silently accepting/parsing something with lost precision.
function isDecimalAmountString_(amountStr) {
  return /^-?(\d+\.?\d*|\.\d+)$/.test(String(amountStr || '').trim());
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
