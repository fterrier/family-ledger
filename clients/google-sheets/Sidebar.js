function includeHtml_(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

// Menu entry point — opens the Add Transaction sidebar.
function showAddTransaction() {
  showEditSidebar_('transactions', null, null);
}

// Menu entry point — opens the Add Balance Assertion sidebar.
function showAddBalanceAssertion() {
  showEditSidebar_('balances', null, null);
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
  return runUserAction_(isEdit ? ('Edit ' + EntityClass.ENTITY_LABEL) : ('Add ' + EntityClass.ENTITY_LABEL), function() {
    const perf = createPerf_();
    setActivePerf_(perf);
    try {
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
        SpreadsheetApp.getActiveSpreadsheet().toast(
          EntityClass.ENTITY_LABEL + ' saved. Failed to refresh issues: ' + (e.message || String(e)),
          'Family Ledger', 5
        );
        return {};
      }

      if (isEdit) {
        SpreadsheetApp.getActiveSpreadsheet().toast(EntityClass.ENTITY_LABEL + ' saved.', 'Family Ledger', 3);
        return {};
      }
      SpreadsheetApp.getActiveSpreadsheet().setActiveSheet(sheet);
      EntityClass.activateAfterCreate_(sheet, finalSpan);
      SpreadsheetApp.getActiveSpreadsheet().toast(EntityClass.ENTITY_LABEL + ' added.', 'Family Ledger', 3);
      return { entityName: entityObj.getName(), span: finalSpan };
    } finally {
      clearActivePerf_();
      perf.log(isEdit ? ('Edit ' + EntityClass.ENTITY_LABEL) : ('Add ' + EntityClass.ENTITY_LABEL));
    }
  });
}

function deleteEntity(entity) {
  const EntityClass = ENTITY_CLASS_REGISTRY[entity.classKey];
  return runUserAction_('Delete ' + EntityClass.ENTITY_LABEL, function() {
    apiFetchJson_('delete', EntityClass.apiPath_(entity.name));
    const sheet = getOrCreateSheet_(FAMILY_LEDGER_SHEET_NAMES[EntityClass.SHEET_KEY]);
    EntityClass.writeToSheet_(sheet, entity.span, []);
    const context = entity.context || EntityClass.loadContext_();
    refreshDoctorIssueSheets_(context.accountResourceToDisplayName || {});
    SpreadsheetApp.getActiveSpreadsheet().toast(EntityClass.ENTITY_LABEL + ' deleted.', 'Family Ledger', 5);
  });
}
