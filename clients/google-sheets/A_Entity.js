var _cachedSpreadsheetTz_ = null;
function getSpreadsheetTz_() {
  if (!_cachedSpreadsheetTz_) {
    _cachedSpreadsheetTz_ = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  }
  return _cachedSpreadsheetTz_;
}

function normalizeEntityDate_(value) {
  if (Object.prototype.toString.call(value) === '[object Date]') {
    return Utilities.formatDate(value, getSpreadsheetTz_(), 'yyyy-MM-dd');
  }
  return String(value || '').trim();
}

// Converts Date objects and 'yyyy-MM-dd' strings to 'Mmm D, YYYY' (e.g. Apr 19, 2026).
function formatDisplayDate_(value) {
  const s = normalizeEntityDate_(value); // normalises Date → 'yyyy-MM-dd' and trims strings
  const match = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return months[parseInt(match[2], 10) - 1] + ' ' + parseInt(match[3], 10) + ', ' + match[1];
  }
  return s;
}

// value is what Sheets hands back for a numeric amount column via getValues() — a
// real JS number already, never a string to parse. No parseFloat needed.
function formatDisplayAmount_(value) {
  if (typeof value !== 'number' || isNaN(value)) return String(value || '');
  return value.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function getDateHeader_(sheetConfig) {
  return sheetConfig.headers.find(function(h) {
    return (sheetConfig.columnLayout[h] || {}).insertionOrder === true;
  });
}

function applyFormulaColumns_(sheet, sheetConfig, span) {
  const ms = managedSheet_(sheet, sheetConfig);
  if (sheetConfig.issueHeader) {
    ms.setColumnFormulas(span, sheetConfig.issueHeader, buildIssueLookupFormula_);
  }
  if (sheetConfig.columnLayout.amount_in_default_currency) {
    const defaultSymbol = getQuickAddDefaultSymbol_();
    if (defaultSymbol) {
      ms.setColumnFormulas(span, 'amount_in_default_currency', buildAmountInDefaultCurrencyFormula_.bind(null, defaultSymbol));
    }
  }
  if (sheetConfig.columnLayout.dest_level_1) {
    ms.setColumnFormulas(span, 'dest_level_1', buildDestLevelFormula_);
  }
}

function applySpanValidation_(sheet, sheetConfig, span) {
  perfWrap_('validation.write', function() { refreshAccountValidation_(sheet, sheetConfig, span); });
  perfWrap_('formulas.write', function() { applyFormulaColumns_(sheet, sheetConfig, span); });
}

function buildEntityAnchors_(sheet, sheetConfig) {
  const lastRow = sheet.getLastRow();
  const anchors = [];
  if (lastRow <= 1) return anchors;
  const dateHeader = getDateHeader_(sheetConfig);
  if (!dateHeader) return anchors;
  const rows = perfWrap_('anchor.read', function() {
    return managedSheet_(sheet, sheetConfig).getRows({ start: 2, count: lastRow - 1 }, ['resource_name', dateHeader]);
  });
  let current = null;
  perfWrap_('anchor.build', function() {
    rows.forEach(function(row, index) {
      const entityName = String(row.resource_name || '').trim();
      if (!entityName) return;
      const rowNumber = index + 2;
      const entityDate = normalizeEntityDate_(row[dateHeader]);
      if (!current || current.entityName !== entityName) {
        if (current) anchors.push(current);
        current = { entityName: entityName, span: { start: rowNumber, count: 1 }, entityDate: entityDate };
        return;
      }
      current.span.count = rowNumber - current.span.start + 1;
    });
  });
  if (current) anchors.push(current);
  return anchors;
}

function findInsertionRowFromAnchors_(anchors, date) {
  const normalizedDate = normalizeEntityDate_(date);
  for (let i = 0; i < anchors.length; i++) {
    if (anchors[i].entityDate > normalizedDate) return anchors[i].span.start;
  }
  const last = anchors[anchors.length - 1];
  return last ? last.span.start + last.span.count : 2;
}

function findEntityInsertionRow_(sheet, sheetConfig, date) {
  return findInsertionRowFromAnchors_(buildEntityAnchors_(sheet, sheetConfig), date);
}

// Binary search over raw date cells for the first row whose date exceeds
// normalizedTarget, searching only rows [lo, hi). Every posting row of one
// entity carries the same transaction_date (Transaction.js's toRows_ always
// writes transaction.transaction_date, never a per-posting date), and the
// sheet is kept globally sorted by date by construction — so the date column
// is a non-decreasing step function, one flat plateau per entity, and a
// binary search over it always lands exactly on a plateau (entity) boundary,
// never mid-entity, regardless of how many rows any single entity spans.
//
// A blank cell (no entity there — a gap row, or sheet.getLastRow() counting
// a trailing row past the real data, which it's prone to via leftover
// formatting or a cleared-but-not-deleted cell) is treated as "greater than
// any target": it's not a real entity that could be "before" the new one, so
// the search always steps left past it, the same way it would step left past
// a real entity that's genuinely later than the target. That's always safe —
// it can only insert the new entity immediately adjacent to a blank run
// rather than exactly where a fully-populated sheet would have, never inside
// a real entity's row block — and it means a blank row anywhere (mid-sheet
// gap or an overcounted tail) resolves correctly without a separate pass to
// find the sheet's true last row first.
function binaryFindDateBoundary_(sheet, dateCol, lo, hi, normalizedTarget) {
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const midDate = normalizeEntityDate_(sheet.getRange(mid, dateCol, 1, 1).getValue());
    if (!midDate || midDate > normalizedTarget) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  return lo;
}

// Bounded-cost equivalent of findEntityInsertionRow_ — same "insert before the
// first strictly-later date" semantics (see findInsertionRowFromAnchors_), but
// without reading every existing row: O(log n) single-cell reads instead of
// one O(n) full-column read. Safe for a single new entity; batch inserts of
// many entities should keep using buildEntityAnchors_'s one-shot read instead
// (see batchInsertEntitiesIntoSheet_) once the per-group binary-search cost
// would exceed that of a single full read.
function findEntityInsertionRowFast_(sheet, sheetConfig, date) {
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return 2;
  const dateHeader = getDateHeader_(sheetConfig);
  if (!dateHeader) return 2;
  const dateCol = getColumnIndex_(sheetConfig, dateHeader);
  const target = normalizeEntityDate_(date);
  return perfWrap_('anchor.binarySearch', function() {
    return binaryFindDateBoundary_(sheet, dateCol, 2, lastRow + 1, target);
  });
}

// Above this many groups in one batch, per-group binary search (each ~log2(n)
// single-cell reads) costs more in aggregate — Apps Script's getRange() has
// real fixed overhead per call — than one full buildEntityAnchors_ read paid
// once for the whole batch. Below it, per-group search wins; this is the
// common single "Add Transaction" case (always 1 group).
var ANCHOR_BATCH_FAST_THRESHOLD_ = 5;

// Computes each group's insertion row without necessarily paying for a full
// buildEntityAnchors_ read: for small batches, binary-searches each group
// independently, using the previous group's result as the next search's lower
// bound (valid because entityGroups is already sorted ascending by date, so
// later groups can only insert at or after earlier ones). Falls back to one
// shared buildEntityAnchors_ read — still just once, not per group — above
// the threshold.
function findInsertionRowsForGroups_(sheet, sheetConfig, entityGroups) {
  if (entityGroups.length <= ANCHOR_BATCH_FAST_THRESHOLD_) {
    const lastRow = sheet.getLastRow();
    const dateHeader = getDateHeader_(sheetConfig);
    if (lastRow <= 1 || !dateHeader) {
      return entityGroups.map(function() { return 2; });
    }
    const dateCol = getColumnIndex_(sheetConfig, dateHeader);
    let lo = 2;
    return entityGroups.map(function(g) {
      const target = normalizeEntityDate_(g.entityDate);
      const found = perfWrap_('anchor.binarySearch', function() {
        return binaryFindDateBoundary_(sheet, dateCol, lo, lastRow + 1, target);
      });
      lo = found;
      return found;
    });
  }
  const anchors = buildEntityAnchors_(sheet, sheetConfig);
  return entityGroups.map(function(g) {
    return findInsertionRowFromAnchors_(anchors, g.entityDate);
  });
}

function entityNeedsReposition_(sheet, sheetConfig, existingSpan, dateHeader, newDate) {
  const currentDate = normalizeEntityDate_(
    managedSheet_(sheet, sheetConfig).getRow(existingSpan.start, [dateHeader])[dateHeader]
  );
  return currentDate !== normalizeEntityDate_(newDate);
}

// Inserts N new entities into the sheet in one batch.
// entityGroups: [{ rows: [...], entityDate: 'yyyy-MM-dd'|null }, ...] (any order).
// Returns an array of spans (one per date-range group), so _commitToSheet_ can capture _span.
function batchInsertEntitiesIntoSheet_(entityGroups, sheet, sheetConfig) {
  if (!entityGroups || entityGroups.length === 0) return [];

  const hasDates = entityGroups.some(function(g) { return !!g.entityDate; });
  const spans = [];

  if (!hasDates) {
    const allRows = [];
    entityGroups.forEach(function(g) { g.rows.forEach(function(r) { allRows.push(r); }); });
    const insertRow = Math.max(sheet.getLastRow(), 1) + 1;
    const span = perfWrap_('rows.resize', function() {
      return resizeContiguousRows_(sheet, { start: insertRow, count: 0 }, allRows.length);
    });
    perfWrap_('rows.write', function() { managedSheet_(sheet, sheetConfig).setRows(span, allRows); });
    applySpanValidation_(sheet, sheetConfig, span);
    return [span];
  }

  // Sort ascending so earlier groups insert first; offset accounting then works top-to-bottom.
  entityGroups = entityGroups.slice().sort(function(a, b) {
    return (a.entityDate || '') < (b.entityDate || '') ? -1 : 1;
  });

  const insertionRows = findInsertionRowsForGroups_(sheet, sheetConfig, entityGroups);

  // Process clusters sharing the same insertion row; track cumulative offset from prior inserts.
  let offset = 0;
  let i = 0;
  while (i < entityGroups.length) {
    let j = i + 1;
    while (j < entityGroups.length && insertionRows[j] === insertionRows[i]) j++;
    const allRows = [];
    for (let k = i; k < j; k++) {
      entityGroups[k].rows.forEach(function(r) { allRows.push(r); });
    }
    const span = perfWrap_('rows.resize', function() {
      return resizeContiguousRows_(sheet, { start: insertionRows[i] + offset, count: 0 }, allRows.length);
    });
    perfWrap_('rows.write', function() { managedSheet_(sheet, sheetConfig).setRows(span, allRows); });
    applySpanValidation_(sheet, sheetConfig, span);
    spans.push(span);
    offset += allRows.length;
    i = j;
  }
  return spans;
}

// Updates an existing entity in the sheet: resize, reposition if date changed, or write in-place.
function applyEntityUpdateToSheet_(sheet, sheetConfig, existingSpan, rows) {
  if (!rows || rows.length === 0) {
    perfWrap_('rows.resize', function() { resizeContiguousRows_(sheet, existingSpan, 0); });
    return null;
  }
  const dateHeader = getDateHeader_(sheetConfig);
  const needsReposition = !!dateHeader &&
    entityNeedsReposition_(sheet, sheetConfig, existingSpan, dateHeader, rows[0][dateHeader]);
  let targetSpan;
  if (needsReposition) {
    perfWrap_('rows.resize', function() { resizeContiguousRows_(sheet, existingSpan, 0); });
    const insertionRow = findEntityInsertionRowFast_(sheet, sheetConfig, rows[0][dateHeader]);
    targetSpan = perfWrap_('rows.resize', function() {
      return resizeContiguousRows_(sheet, { start: insertionRow, count: 0 }, rows.length);
    });
  } else if (existingSpan.count === rows.length) {
    targetSpan = existingSpan;
  } else {
    targetSpan = perfWrap_('rows.resize', function() {
      return resizeContiguousRows_(sheet, existingSpan, rows.length);
    });
  }
  perfWrap_('rows.write', function() { managedSheet_(sheet, sheetConfig).setRows(targetSpan, rows); });
  // Skip when row count is unchanged — existing rows already carry the correct
  // VLOOKUP formula and validation from the prior write. Only re-apply when rows
  // were added, removed, or repositioned.
  if (existingSpan.count !== rows.length || needsReposition) {
    applySpanValidation_(sheet, sheetConfig, targetSpan);
  }
  return targetSpan;
}

class Entity {
  getName() { return (this._api && this._api.name) || null; }
  validate() {}
  setFields(fields) { throw new Error('Entity.setFields() not implemented'); }
  applyEdit(header, value, oldValue) { throw new Error('Entity.applyEdit() not implemented'); }

  // Internal — overridden by subclass, called only by save(). Not part of external API.
  toRows_() { throw new Error('Entity.toRows_() not implemented'); }
  toApiPayload_() { throw new Error('Entity.toApiPayload_() not implemented'); }

  // _span null → date-ordered new-row insertion via batchInsertEntitiesIntoSheet_.
  // _span non-null → in-place update via applyEntityUpdateToSheet_.
  _commitToSheet_(sheet) {
    const rows = this.toRows_();
    if (!rows || rows.length === 0) {
      throw new Error('Entity could not be rendered into the sheet.');
    }
    const resetFields = this.constructor.RESET_ON_SAVE_FIELDS || [];
    rows.forEach(function(row) {
      resetFields.forEach(function(f) { row[f] = ''; });
    });
    const sheetConfig = FAMILY_LEDGER_SHEET_REGISTRY[this.constructor.SHEET_KEY];
    if (this._span) {
      this._span = applyEntityUpdateToSheet_(sheet, sheetConfig, this._span, rows);
    } else {
      const dateHeader = getDateHeader_(sheetConfig);
      const entityDate = dateHeader ? normalizeEntityDate_(rows[0][dateHeader]) : null;
      const spans = batchInsertEntitiesIntoSheet_([{ rows: rows, entityDate: entityDate }], sheet, sheetConfig);
      this._span = spans.length > 0 ? spans[0] : null;
    }
    this.constructor.afterSheetWrite_();
    return this._span || null;
  }

  // Performs the API call and writes result rows to the sheet.
  // Uses this._span to decide POST (null) vs PATCH (existing span) — unless _pendingServerOp
  // is set (see Transaction.applyEdit_'s split_off_amount handling), in which case a custom
  // method (POST .../{name}:verb) is called instead of PATCH/POST.
  // After save, this._span is updated to the final span.
  // Returns final span, or null if aborted (stale generation). Throws on error.
  save(sheet) {
    const entityName = this.getName();
    const existingSpan = this._span;
    const saveGeneration = entityName ? beginSaveGeneration_(entityName) : null;

    let apiResult;
    if (this._pendingServerOp) {
      const op = this._pendingServerOp;
      apiResult = apiFetchJson_('post', this.constructor.apiPath_(entityName) + ':' + op.verb, op.body);
    } else {
      apiResult = existingSpan
        ? this.constructor.updateViaApi_(entityName, this.toApiPayload_(), this.getUpdateMask_())
        : this.constructor.createViaApi_(this.toApiPayload_());
    }

    if (saveGeneration && !isCurrentSaveGeneration_(entityName, saveGeneration)) return null;

    this._api = apiResult;
    return this._commitToSheet_(sheet);
  }

  // Base API methods — use API_RESOURCE_KEY, UPDATE_MASK, and CREATE_EXTRA_FIELDS.
  // Subclasses may override CREATE_EXTRA_FIELDS to inject extra top-level fields into POST bodies.
  static get CREATE_EXTRA_FIELDS() { return { entity_metadata: { source: 'google_sheets_quick_add' } }; }

  // Default collection path is API_RESOURCE_KEY + 's'. Subclasses may override
  // API_COLLECTION_PATH when the plural form doesn't follow this pattern (e.g. hyphens).
  static get API_COLLECTION_PATH() { return this.API_RESOURCE_KEY + 's'; }

  static createViaApi_(payload) {
    return apiFetchJson_('post', '/' + this.API_COLLECTION_PATH, {
      [this.API_RESOURCE_KEY]: Object.assign({}, this.CREATE_EXTRA_FIELDS, payload),
    });
  }

  // Returns the API path for a given entity resource name, derived from API_COLLECTION_PATH.
  // e.g. 'transactions/txn_x' → '/transactions/txn_x'
  //      'balanceAssertions/bal_x' → '/balance-assertions/bal_x'
  static apiPath_(entityName) {
    const id = entityName.split('/').slice(1).join('/');
    return '/' + this.API_COLLECTION_PATH + '/' + id;
  }

  getUpdateMask_() { return undefined; }

  static updateViaApi_(entityName, payload, mask) {
    return apiFetchJson_('patch', this.apiPath_(entityName), {
      [this.API_RESOURCE_KEY]: payload,
      update_mask: mask ?? this.UPDATE_MASK,
    });
  }

  static loadFromApi(name) {
    const apiData = apiFetchJson_('get', this.apiPath_(name));
    return this.fromApi_(apiData, this.loadContext_());
  }

  // Subclass must define as static:
  //   SHEET_KEY: string                           — registry key
  //   ENTITY_LABEL: string                        — for error messages
  //   API_RESOURCE_KEY: string                    — JSON body key and collection name stem
  //   UPDATE_MASK: string                         — comma-separated fields for PATCH
  //   RESOURCE_IDENTITY: { header, multiRow }     — identity column + grouping
  //   RESET_ON_SAVE_FIELDS: string[]              — action columns cleared on save
  //   loadContext_()                              — loads context for fromRows/save
  //   fromRows(rows, context) → Entity
  //   fromApi_(apiEntity, context) → Entity       — internal; use loadFromApi() externally
  //
  // Subclass must define as an instance method:
  //   buildSidebarFields_(mode) → { mode, fields } — reads defaults off this._api, which
  //     getSidebarData() (Sidebar.js) has already hydrated (via loadFromApi for a first-load
  //     edit, or setFields(fieldValues) for a mode-toggle round trip) before calling this.
  //   isEditableHeader(header) → boolean

  // Called after any sheet write (save or delete). No-op by default; subclasses override.
  static afterSheetWrite_() {}

  // Returns a one-line summary string for the multi-select sidebar list.
  // Subclasses override to show entity-specific fields; base falls back to resource_name.
  static buildMultiSelectSummary_(rawRows) {
    return String((rawRows[0] || {}).resource_name || '');
  }

  static buildBulkActions_(_count) { return []; }

  static insertFromApiIntoSheet_(apiEntity, context, sheet) {
    const entity = this.fromApi_(apiEntity, context);
    return entity._commitToSheet_(sheet);
  }

  // Default: 'edit' checkbox opens the generic edit sidebar.
  // Subclasses may override for custom action headers.
  static isActionHeader(h) { return h === 'edit'; }

  // Reconstruct an entity instance from the JSON object serialized into the sidebar template.
  // Falls back to loadContext_() when record.context is absent (e.g., add mode).
  static fromJson_(record) {
    const context = record.context || this.loadContext_();
    const instance = this.fromApi_({ name: record.name || null }, context);
    instance._span = record.span || null;
    return instance;
  }

  static handleEditAction_(sheet, anchorRow, header, value) {
    if (header === 'edit' && (value === true || value === 'TRUE')) {
      managedSheet_(sheet, FAMILY_LEDGER_SHEET_REGISTRY[this.SHEET_KEY])
        .setFields({ start: anchorRow, count: 1 }, { edit: false });
      const entity = findEntityRowsFromAnchor_(this, sheet, anchorRow);
      const entityEntry = {
        name: entity.getName(),
        span: entity._span,
        summary: this.buildMultiSelectSummary_(entity._rawRows || []),
      };
      const session = readSidebarSession_();
      if (session && session.classKey === this.SHEET_KEY) {
        const updatedSession = addToSidebarSession_(session, entityEntry);
        if (updatedSession.selectedEntities.length === 1) {
          showEditSidebar_(this.SHEET_KEY, entity.getName(), entity._span, entity._context);
        } else {
          showMultiSelectSidebar_(updatedSession.classKey, updatedSession.selectedEntities);
        }
      } else {
        createSidebarSession_(this.SHEET_KEY, entityEntry);
        showEditSidebar_(this.SHEET_KEY, entity.getName(), entity._span, entity._context);
      }
    }
  }

  // Called after a new entity is created from the sidebar.
  // Override to focus a specific cell; default is no-op.
  static activateAfterCreate_(sheet, span) {}
}

var ENTITY_REGISTRY = {};
var ENTITY_CLASS_REGISTRY = {};  // keyed by SHEET_KEY (e.g. 'transactions')

function handleEntitySheetEdit_(e) {
  if (!e || !e.range) return;
  const sheet = e.range.getSheet();
  const EntityClass = ENTITY_REGISTRY[sheet.getName()];
  if (!EntityClass) return;
  const row = e.range.getRow();
  const column = e.range.getColumn();
  if (row <= 1) return;
  const header = FAMILY_LEDGER_SHEET_REGISTRY[EntityClass.SHEET_KEY].headers[column - 1];
  if (!EntityClass.isEditableHeader(header)) return;

  if (EntityClass.isActionHeader && EntityClass.isActionHeader(header)) {
    EntityClass.handleEditAction_(sheet, row, header, e.value);
    return;
  }

  const rawValue = e.value ?? '';
  const rawOldValue = e.oldValue ?? '';
  const oldRawValue = String(rawOldValue);

  // GAS writes the new cell value before onEdit fires. For fields that reconstruction
  // aggregates across a multi-row entity's whole group (narration via
  // inferTransactionNarrationFromGroupRows_, payee via readOptionalNormalizedValue_'s
  // "must agree across rows" check), the anchor row's already-edited new value would
  // otherwise be compared against the other rows' still-stale old value and misclassified
  // or rejected outright. Pass the old value as an in-memory override so entity
  // reconstruction sees the pre-edit state without writing back to the sheet (which would
  // cause a visible flicker).
  const anchorRowOverrides =
    header === 'narration' || header === 'payee' ? { [header]: oldRawValue } : null;

  runWithPerf_('Edit ' + EntityClass.ENTITY_LABEL, function(perf) {
    let entity;
    try {
      entity = perf.wrap('entity.load', function() {
        return findEntityRowsFromAnchor_(EntityClass, sheet, row, anchorRowOverrides);
      });
      entity.applyEdit(header, rawValue, oldRawValue, row);
    } catch (error) {
      managedSheet_(sheet, FAMILY_LEDGER_SHEET_REGISTRY[EntityClass.SHEET_KEY])
        .setFields({ start: row, count: 1 }, { [header]: rawOldValue });
      SpreadsheetApp.getActiveSpreadsheet().toast(error.message || String(error), 'Family Ledger', 5);
      return;
    }

    SpreadsheetApp.getActiveSpreadsheet().toast('Saving ' + EntityClass.ENTITY_LABEL + '…', 'Family Ledger', 60);

    try {
      perf.wrap('entity.save', function() { entity.save(sheet); });
    } catch (error) {
      SpreadsheetApp.getActiveSpreadsheet().toast(error.message || String(error), 'Family Ledger', 5);
      return;
    }

    try {
      perf.wrap('doctor.refresh', function() {
        refreshDoctorIssueSheets_(entity._context.accountResourceToDisplayName || {});
      });
    } catch (error) {
      SpreadsheetApp.getActiveSpreadsheet().toast(
        EntityClass.ENTITY_LABEL + ' saved. Failed to refresh issues: ' + (error.message || String(error)),
        'Family Ledger', 5
      );
      return;
    }

    SpreadsheetApp.getActiveSpreadsheet().toast(EntityClass.ENTITY_LABEL + ' saved.', 'Family Ledger', 3);
  });
}

// Raw row scan — ±25-row window, returns { span, entityName, rows } with __rowNumber annotations.
// Used by findEntityRowsFromAnchor_ and findTransactionRowNumbersFromAnchor_ (Phase 1 only).
// anchorRowOverrides: optional { field: value } map applied to the anchor row in-memory,
// so callers can substitute pre-edit values without writing back to the sheet.
function scanEntityRows_(EntityClass, sheet, anchorRow, anchorRowOverrides) {
  const sheetConfig = FAMILY_LEDGER_SHEET_REGISTRY[EntityClass.SHEET_KEY];
  const ms = managedSheet_(sheet, sheetConfig);
  const identity = EntityClass.RESOURCE_IDENTITY;
  const header = identity.header;

  const windowStart = Math.max(2, anchorRow - 25);
  const windowEnd = anchorRow + 25;
  const windowRows = ms.getRows({ start: windowStart, count: windowEnd - windowStart + 1 });
  const anchorIndex = anchorRow - windowStart;

  if (anchorRowOverrides) {
    windowRows[anchorIndex] = Object.assign({}, windowRows[anchorIndex], anchorRowOverrides);
  }

  const entityName = String(windowRows[anchorIndex][header] || '').trim();
  if (!entityName) {
    const label = EntityClass.ENTITY_LABEL || 'entity';
    throw new Error('The selected row does not contain a ' + label + '.');
  }

  if (!identity.multiRow) {
    const row = Object.assign({}, windowRows[anchorIndex], { __rowNumber: anchorRow });
    return { span: { start: anchorRow, count: 1 }, entityName: entityName, rows: [row] };
  }

  let firstIndex = anchorIndex;
  let lastIndex = anchorIndex;
  for (let i = anchorIndex - 1; i >= 0; i--) {
    if (String(windowRows[i][header] || '').trim() !== entityName) break;
    firstIndex = i;
  }
  for (let i = anchorIndex + 1; i < windowRows.length; i++) {
    if (String(windowRows[i][header] || '').trim() !== entityName) break;
    lastIndex = i;
  }

  const span = { start: windowStart + firstIndex, count: lastIndex - firstIndex + 1 };
  const rows = [];
  for (let i = 0; i < span.count; i++) {
    const row = Object.assign({}, windowRows[firstIndex + i]);
    row.__rowNumber = span.start + i;
    rows.push(row);
  }
  return { span: span, entityName: entityName, rows: rows };
}

// Returns a fully constructed Entity with _span and _rawRows set, context loaded via EntityClass.loadContext_().
// anchorRowOverrides: optional { field: value } map passed through to scanEntityRows_ (see above).
function findEntityRowsFromAnchor_(EntityClass, sheet, anchorRow, anchorRowOverrides) {
  const { span, rows } = scanEntityRows_(EntityClass, sheet, anchorRow, anchorRowOverrides);
  const context = EntityClass.loadContext_();
  const entity = EntityClass.fromRows(rows, context, span);
  entity._rawRows = rows;
  return entity;
}

function beginSaveGeneration_(entityName) {
  const properties = PropertiesService.getDocumentProperties();
  const key = 'family_ledger_save_generation:' + entityName;
  const currentValue = parseInt(properties.getProperty(key) || '0', 10);
  const nextValue = String(currentValue + 1);
  properties.setProperty(key, nextValue);
  return nextValue;
}

function isCurrentSaveGeneration_(entityName, generation) {
  return PropertiesService.getDocumentProperties().getProperty('family_ledger_save_generation:' + entityName) === generation;
}
