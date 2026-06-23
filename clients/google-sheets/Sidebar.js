function includeHtml_(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function showAddTransaction() {
  showEditSidebar_('transactions', null, null);
}

function showAddBalanceAssertion() {
  showEditSidebar_('balances', null, null);
}

function showAddAccount() {
  showEditSidebar_('accounts', null, null);
}

function showAddCommodity() {
  showEditSidebar_('commodities', null, null);
}

function showAddAttachment() {
  showEditSidebar_('attachments', null, null);
}

function showAddPrice() {
  showEditSidebar_('prices', null, null);
}

function showEditSidebar_(entityClassKey, entityName, span, context) {
  const EntityClass = ENTITY_CLASS_REGISTRY[entityClassKey];
  const template = HtmlService.createTemplateFromFile('EditSidebar');
  template.entityJson = JSON.stringify({
    classKey: entityClassKey,
    name: entityName || null,
    span: span || null,
    context: context || null,
  });
  const title = entityName
    ? ('Edit ' + EntityClass.ENTITY_LABEL)
    : ('Add ' + EntityClass.ENTITY_LABEL);
  SpreadsheetApp.getUi().showSidebar(template.evaluate().setTitle(title));
}

function getSidebarData(entity, mode, currentPostings) {
  return ENTITY_CLASS_REGISTRY[entity.classKey].buildSidebarFields_(
    entity.name,
    mode || 'simple',
    currentPostings || null
  );
}

function submitEntity(entity, fieldValues) {
  const EntityClass = ENTITY_CLASS_REGISTRY[entity.classKey];
  const isEdit = Boolean(entity.name);
  const actionName = isEdit ? ('Edit ' + EntityClass.ENTITY_LABEL) : ('Add ' + EntityClass.ENTITY_LABEL);
  return runWithPerf_(actionName, function(perf) {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = perf.wrap('sheet.get', function() {
      return getOrCreateSheet_(FAMILY_LEDGER_SHEET_NAMES[EntityClass.SHEET_KEY]);
    });
    const entityObj = perf.wrap('entity.load', function() {
      return EntityClass.fromJson_(entity);
    });
    entityObj.setFields(fieldValues);
    entityObj.validate();

    const finalSpan = perf.wrap(isEdit ? 'api.patch' : 'api.post', function() {
      return entityObj.save(sheet);
    });
    if (!finalSpan) return {};

    try {
      refreshDoctorIssueSheets_((entityObj._context || {}).accountResourceToDisplayName || {});
    } catch (e) {
      ss.toast(EntityClass.ENTITY_LABEL + ' saved. Failed to refresh issues: ' + (e.message || String(e)), 'Family Ledger', 5);
      return {};
    }

    if (isEdit) {
      clearSidebarSession_();
      ss.toast(EntityClass.ENTITY_LABEL + ' saved.', 'Family Ledger', 3);
      return {};
    }
    ss.setActiveSheet(sheet);
    EntityClass.activateAfterCreate_(sheet, finalSpan);
    ss.toast(EntityClass.ENTITY_LABEL + ' added.', 'Family Ledger', 3);
    return { entityName: entityObj.getName(), span: finalSpan };
  });
}

function deleteEntity(entity) {
  const EntityClass = ENTITY_CLASS_REGISTRY[entity.classKey];
  apiFetchJson_('delete', EntityClass.apiPath_(entity.name));
  const sheet = getOrCreateSheet_(FAMILY_LEDGER_SHEET_NAMES[EntityClass.SHEET_KEY]);
  const sheetConfig = FAMILY_LEDGER_SHEET_REGISTRY[EntityClass.SHEET_KEY];
  applyEntityUpdateToSheet_(sheet, sheetConfig, entity.span, []);
  EntityClass.afterSheetWrite_();
  const context = entity.context || EntityClass.loadContext_();
  refreshDoctorIssueSheets_(context.accountResourceToDisplayName || {});
  clearSidebarSession_();
  SpreadsheetApp.getActiveSpreadsheet().toast(EntityClass.ENTITY_LABEL + ' deleted.', 'Family Ledger', 5);
}

// --- Sidebar session management (multi-select state) ---

var SIDEBAR_SESSION_KEY = 'family_ledger_sidebar_session';
var SIDEBAR_SESSION_TTL_MS = 15 * 60 * 1000;

function readSidebarSession_() {
  var props = PropertiesService.getDocumentProperties();
  var raw = props.getProperty(SIDEBAR_SESSION_KEY);
  if (!raw) return null;
  var session = JSON.parse(raw);
  if (Date.now() - session.sessionTimestamp > SIDEBAR_SESSION_TTL_MS) {
    props.deleteProperty(SIDEBAR_SESSION_KEY);
    return null;
  }
  return session;
}

function saveSidebarSession_(session) {
  PropertiesService.getDocumentProperties().setProperty(SIDEBAR_SESSION_KEY, JSON.stringify(session));
}

function createSidebarSession_(classKey, entity) {
  var session = {
    classKey: classKey,
    selectedEntities: [entity],
    sessionTimestamp: Date.now(),
  };
  saveSidebarSession_(session);
  return session;
}

function addToSidebarSession_(session, entity) {
  var alreadyPresent = session.selectedEntities.some(function(e) { return e.name === entity.name; });
  if (!alreadyPresent) {
    session.selectedEntities.push(entity);
  }
  session.sessionTimestamp = Date.now();
  saveSidebarSession_(session);
  return session;
}

function clearSidebarSession_() {
  PropertiesService.getDocumentProperties().deleteProperty(SIDEBAR_SESSION_KEY);
}

function removeFromSidebarSession_(session, entityName) {
  return {
    classKey: session.classKey,
    selectedEntities: session.selectedEntities.filter(function(e) { return e.name !== entityName; }),
    sessionTimestamp: Date.now(),
  };
}

function removeFromMultiSelect(entityName) {
  var session = readSidebarSession_();
  if (!session) return;
  var updated = removeFromSidebarSession_(session, entityName);
  if (updated.selectedEntities.length === 0) {
    clearSidebarSession_();
    return;
  }
  saveSidebarSession_(updated);
  if (updated.selectedEntities.length === 1) {
    var remaining = updated.selectedEntities[0];
    showEditSidebar_(updated.classKey, remaining.name, remaining.span, null);
    return;
  }
  showMultiSelectSidebar_(updated.classKey, updated.selectedEntities);
}

function cancelMultiSelect() {
  clearSidebarSession_();
}

function cancelSidebar() {
  clearSidebarSession_();
}

// --- Multi-select sidebar ---

function pluralLabel_(label, count) {
  return count + ' ' + label + (count === 1 ? '' : 's');
}

function showMultiSelectSidebar_(classKey, selectedEntities) {
  var EntityClass = ENTITY_CLASS_REGISTRY[classKey];
  var template = HtmlService.createTemplateFromFile('BulkActionSidebar');
  template.bulkActionJson = JSON.stringify({
    classKey: classKey,
    entityLabel: EntityClass.ENTITY_LABEL,
    selectedEntities: selectedEntities,
    extraActions: EntityClass.buildBulkActions_(selectedEntities.length),
  });
  var title = pluralLabel_(EntityClass.ENTITY_LABEL, selectedEntities.length) + ' selected';
  SpreadsheetApp.getUi().showSidebar(template.evaluate().setTitle(title));
}

// Removes entity rows from the sheet in descending span order (bottom-up) to keep
// earlier row indices stable while rows are deleted.
function deleteEntitySpansFromSheet_(sheet, sheetConfig, entities) {
  entities.slice().sort(function(a, b) { return b.span.start - a.span.start; })
    .forEach(function(entity) {
      applyEntityUpdateToSheet_(sheet, sheetConfig, entity.span, []);
    });
}

function mergeTransactions(classKey, entities) {
  var EntityClass = ENTITY_CLASS_REGISTRY[classKey];
  var context = EntityClass.loadContext_();
  var sheet = getOrCreateSheet_(FAMILY_LEDGER_SHEET_NAMES[EntityClass.SHEET_KEY]);
  var sheetConfig = FAMILY_LEDGER_SHEET_REGISTRY[EntityClass.SHEET_KEY];

  var merged = apiFetchJson_('post', '/' + EntityClass.API_COLLECTION_PATH + ':merge', {
    primary_transaction: entities[0].name,
    secondary_transaction: entities[1].name,
  });

  entities.forEach(function(entity) {
    apiFetchJson_('delete', EntityClass.apiPath_(entity.name));
  });
  deleteEntitySpansFromSheet_(sheet, sheetConfig, entities);
  var mergedSpan = EntityClass.insertFromApiIntoSheet_(merged, context, sheet);

  refreshDoctorIssueSheets_((context && context.accountResourceToDisplayName) || {});
  clearSidebarSession_();
  showEditSidebar_(EntityClass.SHEET_KEY, merged.name, mergedSpan, context);
}

function deleteMultipleEntities(classKey, entities) {
  var EntityClass = ENTITY_CLASS_REGISTRY[classKey];
  var sheet = getOrCreateSheet_(FAMILY_LEDGER_SHEET_NAMES[EntityClass.SHEET_KEY]);
  var sheetConfig = FAMILY_LEDGER_SHEET_REGISTRY[EntityClass.SHEET_KEY];

  entities.forEach(function(entity) {
    apiFetchJson_('delete', EntityClass.apiPath_(entity.name));
  });
  deleteEntitySpansFromSheet_(sheet, sheetConfig, entities);

  EntityClass.afterSheetWrite_();
  var context = EntityClass.loadContext_();
  refreshDoctorIssueSheets_((context && context.accountResourceToDisplayName) || {});
  clearSidebarSession_();
  SpreadsheetApp.getActiveSpreadsheet().toast(
    pluralLabel_(EntityClass.ENTITY_LABEL, entities.length) + ' deleted.',
    'Family Ledger',
    5
  );
}
