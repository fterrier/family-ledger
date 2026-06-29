sealed class ApiError {
  const ApiError();
}

class NetworkError extends ApiError {
  final String message;
  const NetworkError(this.message);
}

class AuthError extends ApiError {
  const AuthError();
}

class ServerError extends ApiError {
  final int statusCode;
  final String code;
  final String message;
  const ServerError(this.statusCode, this.code, this.message);
}

class ValidationError extends ApiError {
  final String message;
  const ValidationError(this.message);
}

class MissingSettingsError extends ApiError {
  const MissingSettingsError();
}

extension ApiErrorMessage on ApiError {
  String get displayMessage => switch (this) {
    NetworkError e => e.message,
    ServerError e => e.message,
    ValidationError e => e.message,
    AuthError() => 'Authentication failed',
    MissingSettingsError() => 'Server not configured',
  };
}
