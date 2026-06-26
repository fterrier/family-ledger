import 'package:flutter/material.dart';
import '../../core/api_client.dart';
import '../../core/api_error.dart';
import '../../core/secure_settings.dart';

class ServerSettingsScreen extends StatefulWidget {
  final SecureSettings settings;
  final ApiClient apiClient;
  // Called instead of Navigator.pop when shown as the initial setup screen.
  final VoidCallback? onSaved;
  // Always awaited on success — clears all server-specific caches and app prefs.
  // Add new caches to the implementation in app.dart, not here.
  final Future<void> Function() onServerChanged;

  const ServerSettingsScreen({
    super.key,
    required this.settings,
    required this.apiClient,
    required this.onServerChanged,
    this.onSaved,
  });

  @override
  State<ServerSettingsScreen> createState() => _ServerSettingsScreenState();
}

class _ServerSettingsScreenState extends State<ServerSettingsScreen> {
  final _formKey = GlobalKey<FormState>();
  final _urlController = TextEditingController();
  final _tokenController = TextEditingController();
  bool _tokenVisible = false;
  bool _connecting = false;
  String? _errorMessage;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final (url, token) = await (
      widget.settings.getBaseUrl(),
      widget.settings.getToken(),
    ).wait;
    if (!mounted) return;
    setState(() {
      _urlController.text = url ?? '';
      _tokenController.text = token ?? '';
    });
  }

  Future<void> _connect() async {
    if (!_formKey.currentState!.validate()) return;
    setState(() {
      _connecting = true;
      _errorMessage = null;
    });

    await (
      widget.settings.saveBaseUrl(_urlController.text),
      widget.settings.saveToken(_tokenController.text),
    ).wait;

    final healthErr = await widget.apiClient.checkHealth();
    if (healthErr != null) {
      if (mounted) {
        setState(() {
          _connecting = false;
          _errorMessage = switch (healthErr) {
            NetworkError(:final message) => message,
            AuthError() => 'Authentication failed.',
            MissingSettingsError() => 'Server not configured.',
            ValidationError(:final message) ||
            ServerError(:final message) => 'Server error: $message',
          };
        });
      }
      return;
    }

    final result = await widget.apiClient.get(
      '/accounts',
      queryParams: {'page_size': '1'},
    );
    if (result.error != null) {
      if (mounted) {
        setState(() {
          _connecting = false;
          _errorMessage = switch (result.error!) {
            AuthError() => 'Authentication failed. Check your token.',
            NetworkError() => 'Cannot reach server. Check the URL.',
            MissingSettingsError() => 'Server not configured.',
            ValidationError(:final message) ||
            ServerError(:final message) => 'Server error: $message',
          };
        });
      }
      return;
    }

    await widget.onServerChanged();
    if (mounted) {
      if (widget.onSaved != null) {
        widget.onSaved!();
      } else {
        Navigator.pop(context, true);
      }
    }
  }

  @override
  void dispose() {
    _urlController.dispose();
    _tokenController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFF2F2F7),
      appBar: AppBar(
        title: const Text('Server'),
        backgroundColor: Colors.white,
        foregroundColor: const Color(0xFF1C1C1E),
        elevation: 0,
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(1),
          child: Container(height: 1, color: const Color(0xFFE5E5EA)),
        ),
      ),
      body: Form(
        key: _formKey,
        child: ListView(
          children: [
            _sectionHeader('Connection'),
            _card([
              _fieldRow(
                label: 'API URL',
                child: TextFormField(
                  controller: _urlController,
                  keyboardType: TextInputType.url,
                  decoration: const InputDecoration(
                    border: InputBorder.none,
                    hintText: 'http://100.64.x.x:8000',
                    hintStyle: TextStyle(color: Color(0xFFC7C7CC)),
                    isDense: true,
                    contentPadding: EdgeInsets.zero,
                  ),
                  style: const TextStyle(fontSize: 15),
                  validator: (v) =>
                      (v == null || v.trim().isEmpty) ? 'Required' : null,
                ),
              ),
              const Divider(height: 1, color: Color(0xFFF2F2F7)),
              _fieldRow(
                label: 'Token',
                trailing: TextButton(
                  onPressed: () =>
                      setState(() => _tokenVisible = !_tokenVisible),
                  style: TextButton.styleFrom(
                    padding: EdgeInsets.zero,
                    minimumSize: Size.zero,
                    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                  ),
                  child: Text(
                    _tokenVisible ? 'Hide' : 'Show',
                    style: const TextStyle(
                      fontSize: 13,
                      color: Color(0xFF1A73E8),
                    ),
                  ),
                ),
                child: TextFormField(
                  controller: _tokenController,
                  obscureText: !_tokenVisible,
                  decoration: const InputDecoration(
                    border: InputBorder.none,
                    isDense: true,
                    contentPadding: EdgeInsets.zero,
                  ),
                  style: const TextStyle(fontSize: 15),
                  validator: (v) =>
                      (v == null || v.trim().isEmpty) ? 'Required' : null,
                ),
              ),
            ]),
            const SizedBox(height: 16),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: ElevatedButton(
                onPressed: _connecting ? null : _connect,
                style: ElevatedButton.styleFrom(
                  backgroundColor: const Color(0xFF1A73E8),
                  foregroundColor: Colors.white,
                  padding: const EdgeInsets.symmetric(vertical: 16),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(14),
                  ),
                  elevation: 0,
                ),
                child: _connecting
                    ? const SizedBox(
                        height: 18,
                        width: 18,
                        child: CircularProgressIndicator(
                          strokeWidth: 2,
                          color: Colors.white,
                        ),
                      )
                    : const Text(
                        'Connect',
                        style: TextStyle(
                          fontSize: 17,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
              ),
            ),
            if (_errorMessage != null)
              Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: 16,
                  vertical: 8,
                ),
                child: Text(
                  _errorMessage!,
                  textAlign: TextAlign.center,
                  style: const TextStyle(
                    fontSize: 13,
                    color: Color(0xFFD93025),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _sectionHeader(String text) => Padding(
    padding: const EdgeInsets.fromLTRB(16, 20, 16, 6),
    child: Text(
      text.toUpperCase(),
      style: const TextStyle(
        fontSize: 13,
        fontWeight: FontWeight.w600,
        color: Color(0xFF8E8E93),
        letterSpacing: 0.5,
      ),
    ),
  );

  Widget _card(List<Widget> children) => Container(
    margin: const EdgeInsets.symmetric(horizontal: 16),
    decoration: BoxDecoration(
      color: Colors.white,
      borderRadius: BorderRadius.circular(14),
      boxShadow: [
        BoxShadow(
          color: Colors.black.withValues(alpha: 0.07),
          blurRadius: 3,
          offset: const Offset(0, 1),
        ),
      ],
    ),
    child: Column(children: children),
  );

  Widget _fieldRow({
    required String label,
    required Widget child,
    Widget? trailing,
  }) => Padding(
    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
    child: Row(
      children: [
        SizedBox(
          width: 72,
          child: Text(
            label,
            style: const TextStyle(fontSize: 13, color: Color(0xFF8E8E93)),
          ),
        ),
        Expanded(child: child),
        ?trailing,
      ],
    ),
  );
}
