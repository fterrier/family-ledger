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

    try {
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
    } catch (error) {
      throw error;
    }

    return this._span || null;
  }

  // Subclass must define as static:
  //   SHEET_KEY: string                           — registry key
  //   ENTITY_LABEL: string                        — for error messages
  //   RESOURCE_IDENTITY: { header, multiRow }     — identity column + grouping
  //   RESET_ON_SAVE_FIELDS: string[]              — action columns cleared on save
  //   writeToSheet_(sheet, existingSpan, rows)    — positions + writes stamped rows
  //   createViaApi_(payload)                      — POST; returns API result
  //   updateViaApi_(entityName, payload)          — PATCH; returns API result
  //   loadContext_()                              — loads context for fromRows/save
  //   fromRows(rows, context) → Entity
  //   fromApi(apiEntity, context) → Entity
  //   quickAddFields() → FieldDescriptor[]        — Phase 3
  //   isEditableHeader(header) → boolean          — Phase 2
}

var ENTITY_REGISTRY = {};

// Raw row scan — ±25-row window, returns { span, entityName, rows } with __rowNumber annotations.
// Used by findEntityRowsFromAnchor_ and findTransactionRowNumbersFromAnchor_ (Phase 1 only).
function scanEntityRows_(EntityClass, sheet, anchorRow) {
  const sheetConfig = FAMILY_LEDGER_SHEET_REGISTRY[EntityClass.SHEET_KEY];
  const ms = managedSheet_(sheet, sheetConfig);
  const identity = EntityClass.RESOURCE_IDENTITY;
  const header = identity.header;

  const windowStart = Math.max(2, anchorRow - 25);
  const windowEnd = anchorRow + 25;
  const windowRows = ms.getRows({ start: windowStart, count: windowEnd - windowStart + 1 });
  const anchorIndex = anchorRow - windowStart;

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
function findEntityRowsFromAnchor_(EntityClass, sheet, anchorRow) {
  const { span, rows } = scanEntityRows_(EntityClass, sheet, anchorRow);
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
