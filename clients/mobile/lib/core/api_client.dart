import 'dart:convert';
import 'dart:io';
import 'package:http/http.dart' as http;
import 'api_error.dart';
import 'result.dart';
import 'secure_settings.dart';

class ApiClient {
  final SecureSettings _settings;

  ApiClient(this._settings);

  Future<Result<Map<String, dynamic>>> get(
    String path, {
    Map<String, String>? queryParams,
  }) async {
    return _request('GET', path, queryParams: queryParams);
  }

  Future<Result<Map<String, dynamic>>> post(
    String path,
    Map<String, dynamic> body,
  ) async {
    return _request('POST', path, body: body);
  }

  // Health check — unauthenticated, just tests connectivity.
  Future<ApiError?> checkHealth() async {
    final baseUrl = await _settings.getBaseUrl();
    if (baseUrl == null || baseUrl.isEmpty) {
      return const MissingSettingsError();
    }
    try {
      final response = await http
          .get(Uri.parse('$baseUrl/healthz'))
          .timeout(const Duration(seconds: 10));
      if (response.statusCode == 200) return null;
      return ServerError(
        response.statusCode,
        'server_error',
        'Unexpected status ${response.statusCode}',
      );
    } on SocketException catch (e) {
      return NetworkError(e.message);
    } on HttpException catch (e) {
      return NetworkError(e.message);
    } catch (e) {
      return NetworkError(e.toString());
    }
  }

  Future<Result<Map<String, dynamic>>> _request(
    String method,
    String path, {
    Map<String, String>? queryParams,
    Map<String, dynamic>? body,
  }) async {
    final (baseUrl, token) = await (
      _settings.getBaseUrl(),
      _settings.getToken(),
    ).wait;

    if (baseUrl == null || baseUrl.isEmpty || token == null || token.isEmpty) {
      return (data: null, error: const MissingSettingsError());
    }

    var uri = Uri.parse('$baseUrl$path');
    if (queryParams != null && queryParams.isNotEmpty) {
      uri = uri.replace(queryParameters: queryParams);
    }

    final headers = {
      'Authorization': 'Bearer $token',
      'Content-Type': 'application/json',
    };

    try {
      final http.Response response;
      if (method == 'POST') {
        response = await http
            .post(uri, headers: headers, body: jsonEncode(body))
            .timeout(const Duration(seconds: 15));
      } else {
        response = await http
            .get(uri, headers: headers)
            .timeout(const Duration(seconds: 15));
      }

      if (response.statusCode == 401) {
        return (data: null, error: const AuthError());
      }

      final decoded = jsonDecode(response.body) as Map<String, dynamic>;

      if (response.statusCode >= 400) {
        final detail = decoded['detail'];
        final code =
            (detail is Map ? detail['code'] : null) as String? ?? 'error';
        final message =
            (detail is Map ? detail['message'] : detail?.toString())
                as String? ??
            'Unknown error';
        if (response.statusCode == 400) {
          return (data: null, error: ValidationError(message));
        }
        return (
          data: null,
          error: ServerError(response.statusCode, code, message),
        );
      }

      return (data: decoded, error: null);
    } on SocketException catch (e) {
      return (
        data: null,
        error: NetworkError('Cannot reach server: ${e.message}'),
      );
    } on HttpException catch (e) {
      return (data: null, error: NetworkError(e.message));
    } catch (e) {
      return (data: null, error: NetworkError(e.toString()));
    }
  }
}
