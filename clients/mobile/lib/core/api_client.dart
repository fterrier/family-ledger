import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'package:http/http.dart' as http;
import 'package:http_parser/http_parser.dart';
import 'api_error.dart';
import 'result.dart';
import 'secure_settings.dart';

class ApiClient {
  final SecureSettings _settings;
  final http.Client _client = http.Client();

  ApiClient(this._settings);

  Future<ApiError?> checkHealth() async {
    final baseUrl = await _settings.getBaseUrl();
    if (baseUrl == null || baseUrl.isEmpty) {
      return const MissingSettingsError();
    }
    try {
      final response = await _client
          .get(Uri.parse('$baseUrl/healthz'))
          .timeout(const Duration(seconds: 10));
      if (response.statusCode == 200) return null;
      return ServerError(
        response.statusCode,
        'server_error',
        'Unexpected status ${response.statusCode}',
      );
    } catch (e) {
      return _mapException(e);
    }
  }

  Future<Result<Map<String, dynamic>>> get(
    String path, {
    Map<String, String>? queryParams,
  }) => _call(
    path,
    queryParams: queryParams,
    makeRequest: (uri, headers) =>
        _client.get(uri, headers: headers).timeout(const Duration(seconds: 15)),
  );

  Future<Result<Map<String, dynamic>>> post(
    String path,
    Map<String, dynamic> body,
  ) => _call(
    path,
    makeRequest: (uri, headers) => _client
        .post(uri, headers: headers, body: jsonEncode(body))
        .timeout(const Duration(seconds: 15)),
  );

  Future<Result<Map<String, dynamic>>> patch(
    String path,
    Map<String, dynamic> body,
  ) => _call(
    path,
    makeRequest: (uri, headers) => _client
        .patch(uri, headers: headers, body: jsonEncode(body))
        .timeout(const Duration(seconds: 15)),
  );

  Future<ApiError?> delete(String path) => _callVoid(
    path,
    makeRequest: (uri, headers) => _client
        .delete(uri, headers: headers)
        .timeout(const Duration(seconds: 15)),
  );

  Future<Result<Map<String, dynamic>>> postMultipart(
    String path, {
    required Map<String, (Uint8List bytes, String filename)> files,
    String? mimeType,
    String? configOverrideJson,
  }) async {
    final creds = await _resolveCredentials();
    if (creds == null) return (data: null, error: const MissingSettingsError());
    final (baseUrl, token) = creds;

    final uri = Uri.parse('$baseUrl$path');
    final request = http.MultipartRequest('POST', uri)
      ..headers['Authorization'] = 'Bearer $token';

    final contentType = mimeType != null ? MediaType.parse(mimeType) : null;
    for (final entry in files.entries) {
      request.files.add(
        http.MultipartFile.fromBytes(
          entry.key,
          entry.value.$1,
          filename: entry.value.$2,
          contentType: contentType,
        ),
      );
    }
    if (configOverrideJson != null) {
      request.fields['config_override'] = configOverrideJson;
    }

    try {
      final streamed = await _client
          .send(request)
          .timeout(const Duration(seconds: 60));
      final response = await http.Response.fromStream(streamed);
      return _parseResponse(response);
    } catch (e) {
      return (data: null, error: _mapException(e));
    }
  }

  Future<ApiError?> _callVoid(
    String path, {
    required Future<http.Response> Function(Uri, Map<String, String>)
    makeRequest,
  }) async {
    final creds = await _resolveCredentials();
    if (creds == null) return const MissingSettingsError();
    final (baseUrl, token) = creds;
    final uri = Uri.parse('$baseUrl$path');
    final headers = {
      'Authorization': 'Bearer $token',
      'Content-Type': 'application/json',
    };
    try {
      final response = await makeRequest(uri, headers);
      if (response.statusCode == 204 || response.statusCode == 200) return null;
      if (response.statusCode == 401) return const AuthError();
      if (response.body.isEmpty) {
        return ServerError(
          response.statusCode,
          'error',
          'Unexpected status ${response.statusCode}',
        );
      }
      try {
        return _errorFromDecoded(
          response.statusCode,
          jsonDecode(response.body) as Map<String, dynamic>,
        );
      } catch (_) {
        return ServerError(
          response.statusCode,
          'error',
          'Unexpected status ${response.statusCode}',
        );
      }
    } catch (e) {
      return _mapException(e);
    }
  }

  Future<Result<Map<String, dynamic>>> _call(
    String path, {
    Map<String, String>? queryParams,
    required Future<http.Response> Function(Uri, Map<String, String>)
    makeRequest,
  }) async {
    final creds = await _resolveCredentials();
    if (creds == null) return (data: null, error: const MissingSettingsError());
    final (baseUrl, token) = creds;

    var uri = Uri.parse('$baseUrl$path');
    if (queryParams != null && queryParams.isNotEmpty) {
      uri = uri.replace(queryParameters: queryParams);
    }

    final headers = {
      'Authorization': 'Bearer $token',
      'Content-Type': 'application/json',
    };

    try {
      return _parseResponse(await makeRequest(uri, headers));
    } catch (e) {
      return (data: null, error: _mapException(e));
    }
  }

  Future<(String, String)?> _resolveCredentials() async {
    final (baseUrl, token) = await (
      _settings.getBaseUrl(),
      _settings.getToken(),
    ).wait;
    if (baseUrl == null || baseUrl.isEmpty || token == null || token.isEmpty) {
      return null;
    }
    return (baseUrl, token);
  }

  static Result<Map<String, dynamic>> _parseResponse(http.Response response) {
    if (response.statusCode == 401) {
      return (data: null, error: const AuthError());
    }
    final decoded = jsonDecode(response.body) as Map<String, dynamic>;
    if (response.statusCode >= 400) {
      return (
        data: null,
        error: _errorFromDecoded(response.statusCode, decoded),
      );
    }
    return (data: decoded, error: null);
  }

  static ApiError _errorFromDecoded(int statusCode, Map<String, dynamic> body) {
    final detail = body['detail'];
    final code = (detail is Map ? detail['code'] : null) as String? ?? 'error';
    final message =
        (detail is Map ? detail['message'] : detail?.toString()) as String? ??
        'Unknown error';
    if (statusCode == 400) return ValidationError(message);
    return ServerError(statusCode, code, message);
  }

  static ApiError _mapException(Object e) {
    if (e is SocketException) {
      return NetworkError('Cannot reach server: ${e.message}');
    }
    if (e is HttpException) return NetworkError(e.message);
    return NetworkError(e.toString());
  }
}
