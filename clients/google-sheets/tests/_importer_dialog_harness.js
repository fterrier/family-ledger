const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { loadCode } = require('./_harness');
const { makeFakeDom } = require('./_fake_dom');

const DIALOG_HTML_PATH = path.join(__dirname, '..', 'ImporterDialog.html');

const MODE_LINE = 'var IMPORTER_DIALOG_MODE = <?!= JSON.stringify(mode) ?>;';
const INIT_CALL = 'initializeImporterDialog(<?!= initialImportersJson ?>);';
const INCLUDE_ACCOUNT_SEARCH = "<?!= includeHtml_('AccountSearch'); ?>";
const INCLUDE_SEARCH_DROPDOWN = "<?!= includeHtml_('SearchDropdown'); ?>";
const MODE_BRANCH_PATTERN = /<\?\s*if\s*\(isImportMode\)\s*\{\s*\?>([\s\S]*?)<\?\s*\}\s*else\s*\{\s*\?>([\s\S]*?)<\?\s*\}\s*\?>/;

function extractScript(rawHtml) {
  const match = rawHtml.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) {
    throw new Error('Could not find <script> block in ImporterDialog.html');
  }
  return match[1];
}

function stripGasTags(script, mode, initialImporters) {
  let out = script;

  if (!out.includes(MODE_LINE)) {
    throw new Error('ImporterDialog.html mode line changed shape; update _importer_dialog_harness.js');
  }
  out = out.replace(MODE_LINE, 'var IMPORTER_DIALOG_MODE = ' + JSON.stringify(mode) + ';');

  if (!out.includes(INIT_CALL)) {
    throw new Error('ImporterDialog.html init call changed shape; update _importer_dialog_harness.js');
  }
  out = out.replace(INIT_CALL, 'initializeImporterDialog(' + JSON.stringify(initialImporters) + ');');

  out = out.split(INCLUDE_ACCOUNT_SEARCH).join('');
  out = out.split(INCLUDE_SEARCH_DROPDOWN).join('');

  const branchMatch = out.match(MODE_BRANCH_PATTERN);
  if (!branchMatch) {
    throw new Error('ImporterDialog.html isImportMode branch changed shape; update _importer_dialog_harness.js');
  }
  const chosenBranch = mode === 'import' ? branchMatch[1] : branchMatch[2];
  out = out.replace(MODE_BRANCH_PATTERN, chosenBranch);

  if (out.includes('<?')) {
    throw new Error('Unstripped GAS tag remains in ImporterDialog.html script; update _importer_dialog_harness.js');
  }
  return out;
}

function makeGoogleScriptRunStub() {
  const calls = [];
  function newRunner() {
    const pending = {};
    let proxy;
    const base = {
      withSuccessHandler(fn) {
        pending.onSuccess = fn;
        return proxy;
      },
      withFailureHandler(fn) {
        pending.onFailure = fn;
        return proxy;
      },
    };
    proxy = new Proxy(base, {
      get(target, prop) {
        if (prop in target) return target[prop];
        return function(...args) {
          calls.push({
            method: prop,
            args,
            onSuccess: pending.onSuccess,
            onFailure: pending.onFailure,
          });
          return proxy;
        };
      },
    });
    return proxy;
  }
  return {
    calls,
    google: {
      script: {
        get run() {
          return newRunner();
        },
        host: {
          close() {},
        },
      },
    },
  };
}

function loadImporterDialog(mode, initialImporters, staticIds) {
  const { sandbox } = loadCode();
  const { document } = makeFakeDom();
  const runStub = makeGoogleScriptRunStub();

  // Register static elements directly by id so getElementById finds them
  // without needing them attached to a parent tree (production only ever
  // looks them up by id, never traverses from a root).
  (staticIds || []).forEach(function(spec) {
    const el = document.createElement(spec.tagName || 'div');
    el.id = spec.id;
  });

  sandbox.document = document;
  sandbox.google = runStub.google;

  const rawHtml = fs.readFileSync(DIALOG_HTML_PATH, 'utf8');
  const script = stripGasTags(extractScript(rawHtml), mode, initialImporters);

  vm.runInContext(script, sandbox, { filename: 'ImporterDialog.html' });

  return { sandbox, document, scriptRunCalls: runStub.calls };
}

module.exports = { loadImporterDialog };
