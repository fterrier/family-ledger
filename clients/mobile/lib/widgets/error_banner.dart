import 'package:flutter/material.dart';
import '../core/api_error.dart';

class ErrorBanner extends StatelessWidget {
  final ApiError error;
  final VoidCallback? onRetry;
  final VoidCallback? onSettings;

  const ErrorBanner({
    super.key,
    required this.error,
    this.onRetry,
    this.onSettings,
  });

  @override
  Widget build(BuildContext context) {
    final (message, action) = _resolve(error);
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      color: const Color(0xFFFDE8E8),
      child: Row(
        children: [
          const Icon(Icons.error_outline, color: Color(0xFFD93025), size: 18),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              message,
              style: const TextStyle(fontSize: 13, color: Color(0xFF5F2120)),
            ),
          ),
          if (action != null)
            TextButton(
              onPressed: action.$2,
              style: TextButton.styleFrom(
                padding: const EdgeInsets.symmetric(horizontal: 8),
                minimumSize: Size.zero,
                tapTargetSize: MaterialTapTargetSize.shrinkWrap,
              ),
              child: Text(
                action.$1,
                style: const TextStyle(fontSize: 13, color: Color(0xFFD93025)),
              ),
            ),
        ],
      ),
    );
  }

  (String, (String, VoidCallback?)?) _resolve(ApiError err) {
    return switch (err) {
      NetworkError(:final message) => (
        'Cannot reach server. $message',
        onRetry != null ? ('Retry', onRetry) : null,
      ),
      AuthError() => (
        'Authentication failed. Check your API token.',
        onSettings != null ? ('Settings', onSettings) : null,
      ),
      ValidationError(:final message) => (message, null),
      ServerError(:final message) => ('Server error: $message', null),
      MissingSettingsError() => (
        'Server not configured.',
        onSettings != null ? ('Settings', onSettings) : null,
      ),
    };
  }
}

/// Renders [ErrorBanner] when [error] is non-null, nothing otherwise — the
/// "does this screen currently have an error to show" check that would
/// otherwise be hand-written at every call site. Pair with an
/// [ErrorReporter] and a `ValueListenableBuilder<ApiError?>` to go from
/// "an operation reported this" to "the screen shows it" with no
/// intermediate setState.
class MaybeErrorBanner extends StatelessWidget {
  final ApiError? error;
  final VoidCallback? onRetry;
  final VoidCallback? onSettings;

  const MaybeErrorBanner({
    super.key,
    required this.error,
    this.onRetry,
    this.onSettings,
  });

  @override
  Widget build(BuildContext context) {
    final error = this.error;
    return error == null
        ? const SizedBox.shrink()
        : ErrorBanner(error: error, onRetry: onRetry, onSettings: onSettings);
  }
}
