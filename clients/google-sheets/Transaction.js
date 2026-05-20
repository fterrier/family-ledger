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

  toApiPayload_() {
    return {
      transaction_date: this._api.transaction_date,
      payee: this._api.payee || null,
      narration: this._api.narration || null,
      postings: this._api.postings,
    };
  }

  validate() {
    if (!this._api.transaction_date) throw new Error('Transaction date is required.');
    if (!Array.isArray(this._api.postings)) throw new Error('Transaction must have postings.');
  }

  updateFromApi_(apiResponse) {
    this._api = apiResponse;
  }

  // Sidebar: set fields from either simple-mode keys (source_account, destination_account,
  // amount, symbol) or a raw postings array. applyEdit('amount') is a different path that
  // triggers a posting split on inline sheet edits.
  setFields(fields) {
    if ('transaction_date' in fields)
      this._api.transaction_date = normalizeTransactionDate_(fields.transaction_date);
    if ('payee' in fields) this._api.payee = fields.payee || null;
    if ('narration' in fields) this._api.narration = fields.narration || null;
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
      return;
    }

    if (header === 'narration') {
      if (this._span === null || this._span.count <= 1) {
        this._api.narration = String(value || '').trim() || null;
        return;
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
      return;
    }

    if (header === 'destination_account_name') {
      const account = this._context.accountDisplayNameToResource[String(value || '').trim()];
      if (!account) throw new Error('Unknown account_name: ' + value);
      const destOffset = anchorRow - this._span.start;
      this._api.postings[1 + destOffset].account = account;
      return;
    }

    if (header === 'amount') {
      const destinations = this._api.postings.slice(1);
      if (destinations.length === 0) {
        throw new Error('Amount cannot be edited until a destination account is set.');
      }
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
      const total = this._api.postings.slice(1).reduce(function(s, p) { return s + parseFloat(p.units.amount); }, 0);
      this._api.postings[0].units.amount = String(-total);
      return;
    }

    if (header === 'split_off_amount') {
      const instruction = String(value ?? '').trim();
      if (!instruction) return;

      const destinations = this._api.postings.slice(1);
      const destOffset = anchorRow - this._span.start;
      const postingIndex = 1 + destOffset;

      if (instruction === 'x' || instruction === 'X' || instruction === '-') {
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

      if (destinations.length === 0) {
        throw new Error('Split is unavailable until a destination account is set.');
      }
      const splitAmount = parseFloat(instruction);
      const posting = this._api.postings[postingIndex];
      const originalAmount = parseFloat(posting.units.amount);
      if (splitAmount === originalAmount) {
        throw new Error('Split amount must differ from the row amount.');
      }
      posting.units.amount = String(originalAmount - splitAmount);
      this._api.postings.splice(postingIndex + 1, 0, {
        account: posting.account,
        units: { amount: String(splitAmount), symbol: posting.units.symbol },
        narration: null,
      });
      const total = this._api.postings.slice(1).reduce(function(s, p) { return s + parseFloat(p.units.amount); }, 0);
      this._api.postings[0].units.amount = String(-total);
      return;
    }
  }

  // — Static config —

  static get SHEET_KEY() { return 'transactions'; }
  static get RESOURCE_IDENTITY() { return { header: 'resource_name', multiRow: true }; }
  static get RESET_ON_SAVE_FIELDS() { return ['split_off_amount']; }
  static get API_RESOURCE_KEY() { return 'transaction'; }
  static get UPDATE_MASK() { return 'transaction_date,payee,narration,postings'; }
  static get ENTITY_LABEL() { return 'transaction'; }

  static isEditableHeader(h) {
    return ['payee', 'narration', 'destination_account_name', 'amount', 'split_off_amount', 'edit'].indexOf(h) !== -1;
  }

  static loadContext_() {
    return buildTransactionContext_(loadAccountOptions_());
  }

  // Construct from API entity (primary path after an API call).
  static fromApi(apiEntity, context) {
    return new Transaction(apiEntity || {}, context);
  }

  // Construct from sheet rows (inline edit path).
  // Validates rows and reconstructs the API representation via buildTransactionPatchPayload_.
  // Throws if rows are inconsistent or have unknown account names.
  static fromRows(rows, context, span) {
    const api = parseTransactionRowsToApi_(rows, (context || {}).accountDisplayNameToResource || {});
    const tx = new Transaction(api, context);
    tx._span = span || null;
    return tx;
  }

  // Returns { mode, fields } where each field is self-contained with type, label, hint,
  // default, and selection-options. mode: 'simple' | 'advanced'. The server may return
  // 'advanced' even when 'simple' is requested (unclassifiable or multi-destination txn).
  // currentPostings: postings array passed by the client when toggling modes.
  static buildSidebarFields_(entityName, mode, currentPostings) {
    const allRaw = loadAccountOptions_();
    const toOpts = function(list) {
      return list.map(function(o) { return { value: o.resource_name, label: o.display_name }; });
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
      };
    }

    const textFields = baseTextFields.map(function(f) {
      return Object.assign({}, f, { default: transactionDefaults[f.key] || null });
    });

    if (mode === 'advanced') {
      return { mode: 'advanced', fields: textFields.concat([postingsField(postings || [])]) };
    }

    if (postings !== null) {
      const accountResourceToDisplayName = {};
      allRaw.forEach(function(o) { accountResourceToDisplayName[o.resource_name] = o.display_name; });
      const shape = classifySupportedTransaction_({ postings: postings }, accountResourceToDisplayName);

      if (!shape || shape.sourceIndex === null || shape.destinationIndexes.length > 1) {
        return { mode: 'advanced', fields: textFields.concat([postingsField(postings)]) };
      }

      const src = postings[shape.sourceIndex];
      const dst = shape.destinationIndexes.length > 0 ? postings[shape.destinationIndexes[0]] : null;
      return { mode: 'simple', fields: textFields.concat([
        { key: 'source_account',      label: 'Source account',      type: 'account-search', required: true,
          hint: 'Source account for this transaction.', 'selection-options': allAccountOpts, default: src.account },
        { key: 'destination_account', label: 'Destination account', type: 'account-search',
          hint: 'Optional. Leave blank for a source-only transaction.', 'selection-options': allAccountOpts,
          default: dst ? dst.account : null },
        { key: 'amount', label: 'Amount', type: 'number', required: true,
          hint: 'Positive for expenses; negative for incoming money. Same sign convention as the sheet.',
          default: dst ? parseFloat(dst.units.amount) : Math.abs(parseFloat(src.units.amount)) },
        { key: 'symbol', label: 'Symbol', type: 'select', required: true,
          'selection-options': allCommodityOpts, default: src.units.symbol },
      ]) };
    }

    // Add mode: simple form with configured shortlists
    const settings = getAllQuickAddSettings_();
    const sourceOpts = toOpts(allRaw.filter(function(o) { return settings.sourceAccounts.indexOf(o.resource_name) !== -1; }));
    const destOpts   = toOpts(allRaw.filter(function(o) { return settings.destinationAccounts.indexOf(o.resource_name) !== -1; }));
    const symOpts    = buildQuickAddSymbolOptions_(listCommodityOptions_(), settings.symbols)
                         .map(function(o) { return { value: o.symbol, label: o.symbol }; });
    return { mode: 'simple', fields: textFields.concat([
      { key: 'source_account',      label: 'Source account',      type: 'account-search', required: true,
        hint: 'Required. Only the configured quick-add source account shortlist is shown.',
        'selection-options': sourceOpts, default: settings.defaultSourceAccount || null },
      { key: 'destination_account', label: 'Destination account', type: 'account-search',
        hint: 'Optional. Leave blank to create a source-only transaction.',
        'selection-options': destOpts, default: null },
      { key: 'amount', label: 'Amount', type: 'number', required: true,
        hint: 'Required. Positive for expenses; negative for incoming money. Same sign convention as the sheet.' },
      { key: 'symbol', label: 'Symbol', type: 'select', required: true, hint: 'Required.',
        'selection-options': symOpts, default: settings.defaultSymbol || null },
    ]) };
  }

  static activateAfterCreate_(sheet, span) {
    managedSheet_(sheet, FAMILY_LEDGER_SHEET_REGISTRY.transactions).activateCell(span.start, 'payee');
  }

  static writeToSheet_(sheet, existingSpan, rows) {
    return applyTransactionResponseToSheet_(sheet, existingSpan, rows);
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
  return Object.assign({ name: name }, payload);
}

// — Transaction-specific functions (moved from TransactionsSheet.js) —

function flattenTransactionForSheet_(transaction, accountResourceToDisplayName) {
  const shape = classifySupportedTransaction_(transaction, accountResourceToDisplayName);
  if (shape === null) {
    return null;
  }

  const transactionNarration = String(transaction.narration || '');

  if (shape.sourceIndex === null) {
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
    }];
  }

  const sourcePosting = transaction.postings[shape.sourceIndex];
  const sourceAccountName = accountResourceToDisplayName[sourcePosting.account] || sourcePosting.account;
  const sourcePostingNarration = String(sourcePosting.narration || '');

  if (shape.destinationIndexes.length === 0) {
    const postingNarration = sourcePostingNarration;
    return [{
      resource_name: transaction.name,
      narration_source: postingNarration ? 'post' : 'txn',
      transaction_date: transaction.transaction_date,
      payee: transaction.payee || '',
      narration: effectiveSheetNarration_(transactionNarration, postingNarration),
      source_account_name: sourceAccountName,
      destination_account_name: '',
      amount: -parseFloat(sourcePosting.units.amount),
      split_off_amount: '',
      symbol: sourcePosting.units.symbol,
    }];
  }

  return shape.destinationIndexes.map(function(destinationIndex) {
    const posting = transaction.postings[destinationIndex];
    const postingNarration = String(posting.narration || '');
    return {
      resource_name: transaction.name,
      narration_source: postingNarration ? 'post' : 'txn',
      transaction_date: transaction.transaction_date,
      payee: transaction.payee || '',
      narration: effectiveSheetNarration_(transactionNarration, postingNarration),
      source_account_name: sourceAccountName,
      destination_account_name: accountResourceToDisplayName[posting.account] || posting.account,
      amount: parseFloat(posting.units.amount),
      split_off_amount: '',
      symbol: posting.units.symbol,
    };
  });
}

function classifySupportedTransaction_(transaction, accountResourceToDisplayName) {
  if (!transaction || !Array.isArray(transaction.postings)) {
    return null;
  }

  const postings = transaction.postings;

  if (postings.length === 0) {
    return { sourceIndex: null, destinationIndexes: [], symbol: null };
  }

  let symbol = null;
  for (let i = 0; i < postings.length; i++) {
    const p = postings[i];
    if (!p.units || p.cost || p.price) return null;
    if (symbol === null) symbol = p.units.symbol;
    else if (symbol !== p.units.symbol) return null;
  }

  const lookup = accountResourceToDisplayName || {};
  const balanceIndexes = [];
  for (let i = 0; i < postings.length; i++) {
    const name = lookup[postings[i].account] || '';
    if (name.startsWith('[A]') || name.startsWith('[L]')) balanceIndexes.push(i);
  }

  let sourceIndex;
  if (balanceIndexes.length > 0) {
    let negativeBalanceIndex = -1;
    for (let i = 0; i < balanceIndexes.length; i++) {
      if (parseFloat(postings[balanceIndexes[i]].units.amount) < 0) {
        negativeBalanceIndex = balanceIndexes[i];
        break;
      }
    }
    sourceIndex = negativeBalanceIndex >= 0 ? negativeBalanceIndex : balanceIndexes[0];
  } else {
    let negIndex = -1;
    for (let i = 0; i < postings.length; i++) {
      if (parseFloat(postings[i].units.amount) < 0) {
        if (negIndex >= 0) return null;
        negIndex = i;
      }
    }
    if (negIndex < 0) return null;
    sourceIndex = negIndex;
  }

  const destinationIndexes = [];
  for (let i = 0; i < postings.length; i++) {
    if (i !== sourceIndex) destinationIndexes.push(i);
  }
  return { sourceIndex: sourceIndex, destinationIndexes: destinationIndexes, symbol: symbol };
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
    normalizeTransactionDate_
  );
  const payee = readOptionalNormalizedValue_(rows, 'payee', 'payee', issues);
  const narration = inferTransactionNarrationFromGroupRows_(rows, issues);
  const isSplitTransaction = rows.length > 1;
  const sourceAccount = accountDisplayNameToResource[sourceAccountName];
  if (!sourceAccount) throw new Error('Unknown account_name: ' + sourceAccountName);
  const destinationRows = [];
  const blankDestinationRowNumbers = [];
  const amounts = [];

  rows.forEach(function(row, index) {
    const displayRow = row.__rowNumber || index + 2;
    const destinationAccountName = String(row.destination_account_name || '').trim();
    if (!destinationAccountName) {
      blankDestinationRowNumbers.push(displayRow);
    }

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
    }
    amounts.push(amount);
  });

  if (blankDestinationRowNumbers.length > 0 && destinationRows.length > 0) {
    issues.push(
      'Rows for this transaction must either all have destination accounts or all leave destination_account_name blank.'
    );
  }
  if (blankDestinationRowNumbers.length > 1) {
    issues.push('A source-only transaction can only have one visible row.');
  }

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

function normalizeTransactionDate_(value) {
  if (Object.prototype.toString.call(value) === '[object Date]') {
    return Utilities.formatDate(value, 'UTC', 'yyyy-MM-dd');
  }
  return String(value || '').trim();
}

function effectiveSheetNarration_(transactionNarration, postingNarration) {
  const explicitPostingNarration = String(postingNarration || '');
  if (explicitPostingNarration) {
    return explicitPostingNarration;
  }
  return String(transactionNarration || '');
}

function buildTransactionGroupAnchors_(sheet) {
  const lastRow = sheet.getLastRow();
  const anchors = [];
  if (lastRow <= 1) return anchors;
  const txConfig = FAMILY_LEDGER_SHEET_REGISTRY.transactions;
  const rows = managedSheet_(sheet, txConfig).getRows({ start: 2, count: lastRow - 1 }, ['resource_name', 'transaction_date']);
  let current = null;
  rows.forEach(function(row, index) {
    const transactionName = String(row.resource_name || '').trim();
    if (!transactionName) return;
    const rowNumber = index + 2;
    const transactionDate = normalizeTransactionDate_(row.transaction_date);
    if (!current || current.transactionName !== transactionName) {
      if (current) anchors.push(current);
      current = { transactionName: transactionName, span: { start: rowNumber, count: 1 }, transactionDate: transactionDate };
      return;
    }
    current.span.count = rowNumber - current.span.start + 1;
  });
  if (current) anchors.push(current);
  return anchors;
}

function findInsertionRowForTransactionDate_(sheet, transactionDate) {
  const normalizedDate = normalizeTransactionDate_(transactionDate);
  const anchors = buildTransactionGroupAnchors_(sheet);
  for (let index = 0; index < anchors.length; index += 1) {
    if (anchors[index].transactionDate > normalizedDate) {
      return anchors[index].span.start;
    }
  }
  const lastAnchor = anchors[anchors.length - 1];
  return lastAnchor ? lastAnchor.span.start + lastAnchor.span.count : 2;
}

// TODO: unify with applyBalanceResponseToSheet_ under Entity.js once patterns stabilize.
function applyTransactionResponseToSheet_(sheet, existingSpan, replacementRows) {
  let targetSpan;
  if (!existingSpan) {
    const insertionRow = findInsertionRowForTransactionDate_(sheet, replacementRows[0].transaction_date);
    targetSpan = resizeContiguousRows_(sheet, { start: insertionRow, count: 0 }, replacementRows.length);
  } else if (existingSpan.count === replacementRows.length) {
    targetSpan = existingSpan;
  } else {
    targetSpan = resizeContiguousRows_(sheet, existingSpan, replacementRows.length);
  }
  managedSheet_(sheet, FAMILY_LEDGER_SHEET_REGISTRY.transactions).setRows(targetSpan, replacementRows);
  refreshAccountValidation_(sheet, FAMILY_LEDGER_SHEET_REGISTRY.transactions, targetSpan);
  managedSheet_(sheet, FAMILY_LEDGER_SHEET_REGISTRY.transactions).setColumnFormulas(targetSpan, 'issues', buildIssueLookupFormula_);
  return targetSpan;
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
