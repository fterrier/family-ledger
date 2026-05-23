function normalizeEntityDate_(value) {
  return String(value || '').trim();
}

function buildEntityAnchors_(sheet, sheetConfig) {
  const lastRow = sheet.getLastRow();
  const anchors = [];
  if (lastRow <= 1) return anchors;
  const dateHeader = sheetConfig.headers.find(function(h) {
    return (sheetConfig.columnLayout[h] || {}).insertionOrder === true;
  });
  if (!dateHeader) return anchors;
  const rows = managedSheet_(sheet, sheetConfig).getRows({ start: 2, count: lastRow - 1 }, ['resource_name', dateHeader]);
  let current = null;
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
  if (current) anchors.push(current);
  return anchors;
}

function findEntityInsertionRow_(sheet, sheetConfig, date) {
  const normalizedDate = normalizeEntityDate_(date);
  const anchors = buildEntityAnchors_(sheet, sheetConfig);
  for (let index = 0; index < anchors.length; index += 1) {
    if (anchors[index].entityDate > normalizedDate) return anchors[index].span.start;
  }
  const lastAnchor = anchors[anchors.length - 1];
  return lastAnchor ? lastAnchor.span.start + lastAnchor.span.count : 2;
}

function applyEntityResponseToSheet_(sheet, sheetConfig, existingSpan, rows) {
  if (!rows || rows.length === 0) {
    if (existingSpan) resizeContiguousRows_(sheet, existingSpan, 0);
    return null;
  }
  const dateHeader = sheetConfig.headers.find(function(h) {
    return (sheetConfig.columnLayout[h] || {}).insertionOrder === true;
  });
  let targetSpan;
  if (!existingSpan) {
    const insertionRow = findEntityInsertionRow_(sheet, sheetConfig, rows[0][dateHeader]);
    targetSpan = resizeContiguousRows_(sheet, { start: insertionRow, count: 0 }, rows.length);
  } else if (existingSpan.count === rows.length) {
    targetSpan = existingSpan;
  } else {
    targetSpan = resizeContiguousRows_(sheet, existingSpan, rows.length);
  }
  managedSheet_(sheet, sheetConfig).setRows(targetSpan, rows);
  refreshAccountValidation_(sheet, sheetConfig, targetSpan);
  if (sheetConfig.issueHeader) {
    managedSheet_(sheet, sheetConfig).setColumnFormulas(targetSpan, sheetConfig.issueHeader, buildIssueLookupFormula_);
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
  updateFromApi_(apiResponse) { throw new Error('Entity.updateFromApi_() not implemented'); }

  // Performs the API call and writes result rows to the sheet.
  // Uses this._span to decide POST (null) vs PATCH (existing span).
  // After save, this._span is updated to the final span.
  // Returns final span, or null if aborted (stale generation). Throws on error.
  save(sheet) {
    const entityName = this.getName();
    const existingSpan = this._span;
    const saveGeneration = entityName ? beginSaveGeneration_(entityName) : null;

    const apiResult = existingSpan
      ? this.constructor.updateViaApi_(entityName, this.toApiPayload_())
      : this.constructor.createViaApi_(this.toApiPayload_());

    if (saveGeneration && !isCurrentSaveGeneration_(entityName, saveGeneration)) return null;

    this.updateFromApi_(apiResult);

    const rows = this.toRows_();
    if (!rows || rows.length === 0) {
      throw new Error('Entity could not be rendered into the sheet.');
    }

    const resetFields = this.constructor.RESET_ON_SAVE_FIELDS || [];
    rows.forEach(function(row) {
      resetFields.forEach(function(f) { row[f] = ''; });
    });

    this._span = this.constructor.writeToSheet_(sheet, existingSpan, rows);

    return this._span || null;
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

  static updateViaApi_(entityName, payload) {
    return apiFetchJson_('patch', this.apiPath_(entityName), {
      [this.API_RESOURCE_KEY]: payload,
      update_mask: this.UPDATE_MASK,
    });
  }

  // Subclass must define as static:
  //   SHEET_KEY: string                           — registry key
  //   ENTITY_LABEL: string                        — for error messages
  //   API_RESOURCE_KEY: string                    — JSON body key and collection name stem
  //   UPDATE_MASK: string                         — comma-separated fields for PATCH
  //   RESOURCE_IDENTITY: { header, multiRow }     — identity column + grouping
  //   RESET_ON_SAVE_FIELDS: string[]              — action columns cleared on save
  //   writeToSheet_(sheet, existingSpan, rows)    — positions + writes stamped rows
  //   loadContext_()                              — loads context for fromRows/save
  //   buildSidebarFields_(entityName, mode, currentPostings?) → { mode, fields }
  //   fromRows(rows, context) → Entity
  //   fromApi(apiEntity, context) → Entity
  //   isEditableHeader(header) → boolean

  static writeToSheet_(sheet, existingSpan, rows) {
    return applyEntityResponseToSheet_(sheet, FAMILY_LEDGER_SHEET_REGISTRY[this.SHEET_KEY], existingSpan, rows);
  }

  // Default: 'edit' checkbox opens the generic edit sidebar.
  // Subclasses may override for custom action headers.
  static isActionHeader(h) { return h === 'edit'; }

  // Reconstruct an entity instance from the JSON object serialized into the sidebar template.
  // Falls back to loadContext_() when record.context is absent (e.g., add mode).
  static fromJson_(record) {
    const context = record.context || this.loadContext_();
    const instance = this.fromApi({ name: record.name || null }, context);
    instance._span = record.span || null;
    return instance;
  }

  static handleEditAction_(sheet, anchorRow, header, value) {
    if (header === 'edit' && (value === true || value === 'TRUE')) {
      managedSheet_(sheet, FAMILY_LEDGER_SHEET_REGISTRY[this.SHEET_KEY])
        .setFields({ start: anchorRow, count: 1 }, { edit: false });
      const entity = findEntityRowsFromAnchor_(this, sheet, anchorRow);
      showEditSidebar_(this.SHEET_KEY, entity.getName(), entity._span, entity._context);
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

  const rawValue = header === 'amount' ? (e.range.getValue() ?? '') : (e.value ?? '');
  const rawOldValue = e.oldValue ?? '';  // preserve original type (number for amount cells)
  const oldRawValue = String(rawOldValue);

  // GAS writes the new cell value before onEdit fires. For narration edits on multi-row
  // entities, inferTransactionNarrationFromGroupRows_ would pick the already-edited first
  // row's new value as the transaction narration, causing applyEdit to misclassify it.
  // Pass the old value as an in-memory override so entity reconstruction sees the pre-edit
  // state without writing back to the sheet (which would cause a visible flicker).
  const anchorRowOverrides = header === 'narration' ? { narration: oldRawValue } : null;

  let entity;
  try {
    entity = findEntityRowsFromAnchor_(EntityClass, sheet, row, anchorRowOverrides);
    entity.applyEdit(header, rawValue, oldRawValue, row);
  } catch (error) {
    managedSheet_(sheet, FAMILY_LEDGER_SHEET_REGISTRY[EntityClass.SHEET_KEY])
      .setFields({ start: row, count: 1 }, { [header]: rawOldValue });
    SpreadsheetApp.getActiveSpreadsheet().toast(error.message || String(error), 'Family Ledger', 5);
    return;
  }

  SpreadsheetApp.getActiveSpreadsheet().toast('Saving ' + EntityClass.ENTITY_LABEL + '…', 'Family Ledger', 60);

  try {
    entity.save(sheet);
  } catch (error) {
    SpreadsheetApp.getActiveSpreadsheet().toast(error.message || String(error), 'Family Ledger', 5);
    return;
  }

  try {
    refreshDoctorIssueSheets_(entity._context.accountResourceToDisplayName || {});
  } catch (error) {
    SpreadsheetApp.getActiveSpreadsheet().toast(
      EntityClass.ENTITY_LABEL + ' saved. Failed to refresh issues: ' + (error.message || String(error)),
      'Family Ledger', 5
    );
    return;
  }

  SpreadsheetApp.getActiveSpreadsheet().toast(EntityClass.ENTITY_LABEL + ' saved.', 'Family Ledger', 3);
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

// Returns a fully constructed Entity with _span set and context loaded via EntityClass.loadContext_().
// anchorRowOverrides: optional { field: value } map passed through to scanEntityRows_ (see above).
function findEntityRowsFromAnchor_(EntityClass, sheet, anchorRow, anchorRowOverrides) {
  const { span, rows } = scanEntityRows_(EntityClass, sheet, anchorRow, anchorRowOverrides);
  const context = EntityClass.loadContext_();
  return EntityClass.fromRows(rows, context, span);
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
