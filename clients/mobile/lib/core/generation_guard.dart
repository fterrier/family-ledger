/// Discards a stale async result when a newer operation of the same kind
/// has started since — the "last request wins" pattern for a debounced or
/// re-triggerable fetch (e.g. a search-as-you-type request, or a refresh
/// that can be re-triggered before the previous one finishes). Call
/// [start] before awaiting, then check [isCurrent] with the same token
/// after: if it's no longer current, a later call has superseded this one
/// and its result must not be applied.
class GenerationGuard {
  int _generation = 0;

  /// Starts a new operation and returns a token to check later via
  /// [isCurrent]. Any operation started before this one is now stale.
  int start() => ++_generation;

  /// Whether [generation] (from a prior [start]) is still the most recent
  /// one — i.e. no newer operation has started since.
  bool isCurrent(int generation) => generation == _generation;

  /// Whether [start] has been called at least once.
  bool get hasStarted => _generation > 0;
}
