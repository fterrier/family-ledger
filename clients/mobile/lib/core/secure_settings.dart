import 'package:flutter_secure_storage/flutter_secure_storage.dart';

class SecureSettings {
  static const _storage = FlutterSecureStorage();
  static const _keyBaseUrl = 'family_ledger_base_url';
  static const _keyToken = 'family_ledger_api_token';

  Future<String?> getBaseUrl() => _storage.read(key: _keyBaseUrl);
  Future<String?> getToken() => _storage.read(key: _keyToken);

  Future<void> saveBaseUrl(String value) => _storage.write(
    key: _keyBaseUrl,
    value: value.trim().replaceAll(RegExp(r'/+$'), ''),
  );

  Future<void> saveToken(String value) =>
      _storage.write(key: _keyToken, value: value.trim());

  Future<bool> isConfigured() async {
    final (url, token) = await (getBaseUrl(), getToken()).wait;
    return url != null && url.isNotEmpty && token != null && token.isNotEmpty;
  }
}
