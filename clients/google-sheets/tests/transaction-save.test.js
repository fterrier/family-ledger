const test = require('node:test');
const assert = require('node:assert/strict');

const { loadCode, sampleTransaction, makeRowStoreSheet_ } = require('./_harness');

// --- saveTransactionToSheet_ ---
// These tests mock flattenTransactionForSheet_ and applyTransactionResponseToSheet_
// to keep focus on the lifecycle behavior (status tracking, error handling, generation).

function makeSaveTransactionSandbox(rowStore, overrides) {
  const { sandbox } = loadCode(overrides);
  const fakeSheet = makeRowStoreSheet_(sandbox, rowStore, []);
  // Default mocks for the flatten+apply+doctor steps; override per test when testing those paths.
  sandbox.flattenTransactionForSheet_ = function() {
    return [{ transaction_date: '2026-04-19', split_off_amount: '' }];
  };
  sandbox.applyTransactionResponseToSheet_ = function(sheet, existingSpan) {
    return existingSpan || { start: 2, count: 1 };
  };
  sandbox.refreshDoctorIssueSheets_ = function() {};
  return { sandbox, fakeSheet };
}

test('saveTransactionToSheet_ rethrows doApiCall errors', () => {
  const { sandbox, fakeSheet } = makeSaveTransactionSandbox(new Map());

  assert.throws(function() {
    sandbox.saveTransactionToSheet_(fakeSheet, { start: 2, count: 1 }, 'transactions/txn_1', {},
      function() { throw new Error('network error'); }
    );
  }, /network error/);
});

test('saveTransactionToSheet_ aborts cleanly when doApiCall returns null (stale generation)', () => {
  const { sandbox, fakeSheet } = makeSaveTransactionSandbox(new Map());

  const result = sandbox.saveTransactionToSheet_(fakeSheet, { start: 2, count: 1 }, 'transactions/txn_1', {},
    function() { return null; }
  );

  assert.equal(result, null);
});

test('saveTransactionToSheet_ throws when flattenTransactionForSheet_ returns empty rows', () => {
  const { sandbox, fakeSheet } = makeSaveTransactionSandbox(new Map());
  sandbox.flattenTransactionForSheet_ = function() { return []; };

  assert.throws(function() {
    sandbox.saveTransactionToSheet_(fakeSheet, { start: 2, count: 1 }, 'transactions/txn_1', {},
      function() { return { name: 'transactions/txn_1' }; }
    );
  }, /could not be rendered/);
});

test('saveTransactionToSheet_ shows failure toast when doctor refresh fails', () => {
  const toasts = [];
  const { sandbox, fakeSheet } = makeSaveTransactionSandbox(new Map(), {
    SpreadsheetApp: {
      getActiveSpreadsheet() {
        return { toast(message, title, seconds) { toasts.push({ message, title, seconds }); } };
      },
    },
  });
  sandbox.refreshDoctorIssueSheets_ = function() { throw new Error('doctor down'); };

  sandbox.saveTransactionToSheet_(fakeSheet, { start: 2, count: 1 }, 'transactions/txn_1', {},
    function() { return { name: 'transactions/txn_1' }; }
  );

  assert.equal(toasts.length, 1);
  assert.match(toasts[0].message, /failed to refresh ledger doctor issues/);
});
