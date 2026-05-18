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

  // Quick Add / sidebar: set top-level fields on the internal API representation.
  // Note: setting 'amount' here is a simple scalar assignment (total amount for the
  // transaction). This is different from applyEdit('amount', ...) which is an inline
  // sheet edit that triggers a posting split — handled via the edit trigger path.
  setFields(fields) {
    if ('transaction_date' in fields) this._api.transaction_date = fields.transaction_date;
    if ('payee' in fields) this._api.payee = fields.payee || null;
    if ('narration' in fields) this._api.narration = fields.narration || null;
    // Phase 3: implement source_account, destination_account, amount, symbol
    // (these map to postings[] on the API representation)
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
          throw new Error('At least one split row must keep the transaction narration.');
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
        if (destinations.length === 2) adjacent.narration = null;
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
  static get UPDATE_MASK() { return 'payee,narration,postings'; }
  static get ENTITY_LABEL() { return 'transaction'; }

  static isEditableHeader(h) {
    return ['payee', 'narration', 'destination_account_name', 'amount', 'split_off_amount', 'edit'].indexOf(h) !== -1;
  }

  static isActionHeader(h) { return h === 'edit'; }

  // Phase 3: make generic — entity class passed as parameter to the sidebar so
  // the sidebar can be shared across entity types (accounts, balances, etc.).
  static handleEditAction_(sheet, anchorRow, header, value) {
    if (header === 'edit' && (value === true || value === 'TRUE')) {
      managedSheet_(sheet, FAMILY_LEDGER_SHEET_REGISTRY.transactions)
        .setFields({ start: anchorRow, count: 1 }, { edit: false });
      openEditTransactionSidebar_(sheet, anchorRow);
    }
  }

  static loadContext_() {
    return buildTransactionContext_(loadAccountOptions_());
  }

  static createViaApi_(payload) {
    return apiFetchJson_('post', '/transactions', { transaction: payload });
  }

  static updateViaApi_(entityName, payload) {
    return apiFetchJson_('patch', '/' + entityName, {
      transaction: payload,
      update_mask: Transaction.UPDATE_MASK,
    });
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

  // Quick Add field schema — Phase 3.
  static quickAddFields() { return []; }

  // Determine target span, write stamped rows, apply post-write ops (account
  // validation, issue formulas). Returns final span.
  // Delegates to applyTransactionResponseToSheet_ in TransactionsSheet.js.
  static writeToSheet_(sheet, existingSpan, rows) {
    return applyTransactionResponseToSheet_(sheet, existingSpan, rows);
  }
}

function openEditTransactionSidebar_(sheet, rowNumber) {
  managedSheet_(sheet, FAMILY_LEDGER_SHEET_REGISTRY.transactions)
    .setFields({ start: rowNumber, count: 1 }, { edit: false });
  let transactionName;
  try {
    transactionName = findEntityRowsFromAnchor_(Transaction, sheet, rowNumber).getName();
  } catch (_e) {
    SpreadsheetApp.getUi().alert(
      'Edit Transaction',
      'The selected row does not contain a transaction.',
      SpreadsheetApp.getUi().ButtonSet.OK
    );
    return;
  }
  const template = HtmlService.createTemplateFromFile('QuickAddTransactionSidebar');
  template.transactionName = transactionName;
  template.anchorRow = rowNumber;
  SpreadsheetApp.getUi().showSidebar(template.evaluate().setTitle('Edit Transaction'));
}

// Populate the entity registry after class is defined.
ENTITY_REGISTRY[FAMILY_LEDGER_SHEET_NAMES.transactions] = Transaction;

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
      issues: '',
    }];
  }

  const sourcePosting = transaction.postings[shape.sourceIndex];
  const sourceAccountName = accountResourceToDisplayName[sourcePosting.account] || sourcePosting.account;
  const sourcePostingNarration = String(sourcePosting.narration || '');
  const issues = '';

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
      issues: issues,
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
      issues: issues,
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

function normalizeOptionalSheetText_(value) {
  const normalized = String(value || '').trim();
  return normalized ? normalized : null;
}

function inferTransactionNarrationFromGroupRows_(rows, issues) {
  const transactionRows = rows.filter(function(row) {
    return String(row.narration_source || 'txn').trim() !== 'post';
  });
  if (transactionRows.length === 0) {
    issues.push('At least one split row must keep the transaction narration.');
    return null;
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
