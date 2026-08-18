import 'package:flutter/foundation.dart';

import 'api_error.dart';

/// Where an operation reports its outcome, and a screen listens for what to
/// show — decouples "something failed" from "how it's displayed." Scoped to
/// one screen/sheet visit (constructed fresh by whoever opens it, not a
/// long-lived singleton), so tests can hand in a plain instance and either
/// read [value] directly or pump the widget and check what it renders.
class ErrorReporter extends ValueNotifier<ApiError?> {
  ErrorReporter() : super(null);

  void report(ApiError? error) => value = error;

  void clear() => value = null;
}
