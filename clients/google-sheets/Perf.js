let activePerf_ = null;

function setActivePerf_(perf) { activePerf_ = perf; }
function clearActivePerf_()   { activePerf_ = null; }
function getActivePerf_()     { return activePerf_; }

// Lets deeply-nested functions record a labeled span without threading `perf`
// through every signature — a no-op when no perf is active (e.g. called
// outside runWithPerf_).
function perfWrap_(label, fn, meta) {
  const perf = getActivePerf_();
  return perf ? perf.wrap(label, fn, meta) : fn();
}

function createPerf_() {
  const startedAt_ = Date.now();
  const spans_ = [];
  const active_ = {};

  return {
    start: function(label) {
      active_[label] = Date.now();
    },
    end: function(label, meta) {
      const ms = Date.now() - (active_[label] || Date.now());
      spans_.push({ label: label, ms: ms, meta: meta || null });
      delete active_[label];
    },
    record: function(label, ms, meta) {
      spans_.push({ label: label, ms: ms, meta: meta || null });
    },
    wrap: function(label, fn, meta) {
      console.log('[perf] ' + label);
      this.start(label);
      const r = fn();
      this.end(label, typeof meta === 'function' ? meta(r) : (meta || null));
      return r;
    },
    summary: function(opName) {
      const wallMs = Date.now() - startedAt_;
      const spansMs = spans_.reduce(function(s, sp) { return s + sp.ms; }, 0);
      const untracked = wallMs - spansMs;
      const header = '[perf] ' + opName + ' — total: ' + (wallMs / 1000).toFixed(2) + 's' +
        (untracked > 50 ? '  (' + (untracked / 1000).toFixed(2) + 's untracked)' : '');
      const lines = [header];
      spans_.forEach(function(sp) {
        const suffix = sp.meta != null ? '  (' + sp.meta + ')' : '';
        lines.push('  ' + sp.label.padEnd(40) + (sp.ms / 1000).toFixed(3) + 's' + suffix);
      });
      return lines.join('\n');
    },
    log: function(opName) {
      console.log(this.summary(opName));
    },
  };
}
