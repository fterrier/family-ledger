import 'dart:io';
import 'dart:typed_data';
import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:path/path.dart' as p;
import '../../core/api_error.dart';
import '../../models/import_result.dart';
import '../../models/importer.dart';
import '../../repositories/importer_repository.dart';
import '../../widgets/error_banner.dart';

const _cardDecoration = BoxDecoration(
  color: Colors.white,
  borderRadius: BorderRadius.all(Radius.circular(14)),
  boxShadow: [
    BoxShadow(color: Color(0x12000000), blurRadius: 3, offset: Offset(0, 1)),
  ],
);

class ImportScreen extends StatefulWidget {
  final ImporterRepository importerRepository;
  final VoidCallback? onOpenSettings;
  final String? initialFilePath;
  final String? initialMimeType;

  const ImportScreen({
    super.key,
    required this.importerRepository,
    this.onOpenSettings,
    this.initialFilePath,
    this.initialMimeType,
  });

  @override
  State<ImportScreen> createState() => _ImportScreenState();
}

class _ImportScreenState extends State<ImportScreen> {
  List<Importer>? _importers;
  String? _filePath;
  String? _mimeType;
  String? _fileSize;
  String? _selectedImporterPluginName;
  bool _uploading = false;
  ApiError? _error;
  ImportResult? _result;

  @override
  void initState() {
    super.initState();
    _filePath = widget.initialFilePath;
    _mimeType = widget.initialMimeType;
    _fileSize = _computeFileSize(widget.initialFilePath);
    _loadImporters();
  }

  Future<void> _loadImporters() async {
    final result = await widget.importerRepository.getImporters();
    if (!mounted) return;
    setState(() {
      _error = result.error;
      _importers = result.data;
    });
  }

  void _resetState({String? filePath, String? mimeType}) {
    _filePath = filePath;
    _mimeType = mimeType;
    _fileSize = _computeFileSize(filePath);
    _result = null;
    _error = null;
    _selectedImporterPluginName = null;
  }

  Future<void> _pickFile() async {
    final picked = await FilePicker.pickFiles();
    if (picked == null || picked.files.isEmpty) return;
    final file = picked.files.first;
    if (!mounted) return;
    setState(() => _resetState(filePath: file.path));
  }

  void _clearFile() {
    setState(() => _resetState());
  }

  Future<void> _submit() async {
    final importer = _importers?.firstWhere(
      (i) => i.pluginName == _selectedImporterPluginName,
    );
    if (importer == null || _filePath == null) return;

    final fieldName = importer.fileDescriptors.isNotEmpty
        ? importer.fileDescriptors.first.name
        : 'file';
    final filename = p.basename(_filePath!);

    setState(() {
      _uploading = true;
      _error = null;
    });

    Uint8List bytes;
    try {
      bytes = await File(_filePath!).readAsBytes();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _uploading = false;
        _error = NetworkError('Could not read file: $e');
      });
      return;
    }

    final result = await widget.importerRepository.importFile(
      importerName: importer.name,
      fieldName: fieldName,
      filename: filename,
      fileBytes: bytes,
      mimeType: _mimeType,
    );
    if (!mounted) return;

    if (result.error != null) {
      setState(() {
        _uploading = false;
        _error = result.error;
      });
      return;
    }

    setState(() {
      _uploading = false;
      _result = result.data;
    });
  }

  static String? _computeFileSize(String? path) {
    if (path == null) return null;
    try {
      final size = File(path).lengthSync();
      if (size < 1024) return '$size B';
      if (size < 1024 * 1024) return '${(size / 1024).toStringAsFixed(0)} KB';
      return '${(size / (1024 * 1024)).toStringAsFixed(1)} MB';
    } catch (_) {
      return null;
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFF2F2F7),
      appBar: AppBar(
        title: const Text('Import'),
        backgroundColor: Colors.white,
        foregroundColor: const Color(0xFF1C1C1E),
        elevation: 0,
        bottom: _uploading
            ? const PreferredSize(
                preferredSize: Size.fromHeight(3),
                child: LinearProgressIndicator(
                  backgroundColor: Color(0xFFE5E5EA),
                  color: Color(0xFF1A73E8),
                ),
              )
            : PreferredSize(
                preferredSize: const Size.fromHeight(1),
                child: Container(height: 1, color: const Color(0xFFE5E5EA)),
              ),
      ),
      body: Column(
        children: [
          if (_error != null)
            ErrorBanner(
              error: _error!,
              onRetry: _error is NetworkError && _importers == null
                  ? _loadImporters
                  : null,
              onSettings: widget.onOpenSettings,
            ),
          Expanded(
            child: ListView(
              padding: const EdgeInsets.symmetric(vertical: 16),
              children: [
                if (_result != null)
                  _ResultCard(result: _result!)
                else if (_filePath != null) ...[
                  _FileCard(
                    filePath: _filePath!,
                    fileSize: _fileSize,
                    onClear: _clearFile,
                  ),
                  const SizedBox(height: 16),
                  if (_importers != null)
                    _ImporterDropdown(
                      importers: _importers!,
                      value: _selectedImporterPluginName,
                      onChanged: (v) =>
                          setState(() => _selectedImporterPluginName = v),
                    ),
                ] else
                  _EmptyCard(onPickFile: _pickFile),
              ],
            ),
          ),
          if (_filePath != null && _result == null)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 32),
              child: ElevatedButton(
                onPressed: _uploading || _selectedImporterPluginName == null
                    ? null
                    : _submit,
                style: ElevatedButton.styleFrom(
                  backgroundColor: const Color(0xFF1A73E8),
                  foregroundColor: Colors.white,
                  disabledBackgroundColor: const Color(0xFFB0CCEF),
                  minimumSize: const Size.fromHeight(52),
                  padding: const EdgeInsets.symmetric(vertical: 16),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(14),
                  ),
                  elevation: 0,
                ),
                child: const Text(
                  'Run Import',
                  style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600),
                ),
              ),
            ),
          if (_result != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 32),
              child: Row(
                children: [
                  Expanded(
                    child: OutlinedButton(
                      onPressed: _clearFile,
                      style: OutlinedButton.styleFrom(
                        padding: const EdgeInsets.symmetric(vertical: 16),
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(14),
                        ),
                        side: const BorderSide(color: Color(0xFF1A73E8)),
                        foregroundColor: const Color(0xFF1A73E8),
                      ),
                      child: const Text(
                        'Import Another',
                        style: TextStyle(
                          fontSize: 17,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: ElevatedButton(
                      onPressed: () => Navigator.pop(context),
                      style: ElevatedButton.styleFrom(
                        backgroundColor: const Color(0xFF1A73E8),
                        foregroundColor: Colors.white,
                        padding: const EdgeInsets.symmetric(vertical: 16),
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(14),
                        ),
                        elevation: 0,
                      ),
                      child: const Text(
                        'Done',
                        style: TextStyle(
                          fontSize: 17,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

// ---------------------------------------------------------------------------

class _EmptyCard extends StatelessWidget {
  final VoidCallback onPickFile;

  const _EmptyCard({required this.onPickFile});

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 16),
      padding: const EdgeInsets.all(24),
      decoration: _cardDecoration,
      child: Column(
        children: [
          const Icon(
            Icons.upload_file_outlined,
            size: 48,
            color: Color(0xFFC7C7CC),
          ),
          const SizedBox(height: 12),
          const Text(
            'No file selected',
            style: TextStyle(
              fontSize: 17,
              fontWeight: FontWeight.w600,
              color: Color(0xFF1C1C1E),
            ),
          ),
          const SizedBox(height: 20),
          SizedBox(
            width: double.infinity,
            child: OutlinedButton(
              onPressed: onPickFile,
              style: OutlinedButton.styleFrom(
                padding: const EdgeInsets.symmetric(vertical: 14),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(12),
                ),
                side: const BorderSide(color: Color(0xFF1A73E8)),
                foregroundColor: const Color(0xFF1A73E8),
              ),
              child: const Text(
                'Choose a file…',
                style: TextStyle(fontSize: 16, fontWeight: FontWeight.w500),
              ),
            ),
          ),
          const SizedBox(height: 16),
          const Text(
            'Or share from your banking app',
            style: TextStyle(fontSize: 13, color: Color(0xFF8E8E93)),
            textAlign: TextAlign.center,
          ),
        ],
      ),
    );
  }
}

// ---------------------------------------------------------------------------

class _FileCard extends StatelessWidget {
  final String filePath;
  final String? fileSize;
  final VoidCallback onClear;

  const _FileCard({
    required this.filePath,
    required this.fileSize,
    required this.onClear,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 16),
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      decoration: _cardDecoration,
      child: Row(
        children: [
          Container(
            width: 40,
            height: 40,
            decoration: BoxDecoration(
              color: const Color(0xFFEBF2FE),
              borderRadius: BorderRadius.circular(10),
            ),
            child: const Icon(
              Icons.description_outlined,
              color: Color(0xFF1A73E8),
              size: 22,
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  p.basename(filePath),
                  style: const TextStyle(
                    fontSize: 15,
                    fontWeight: FontWeight.w500,
                    color: Color(0xFF1C1C1E),
                  ),
                  overflow: TextOverflow.ellipsis,
                ),
                if (fileSize != null)
                  Text(
                    fileSize!,
                    style: const TextStyle(
                      fontSize: 13,
                      color: Color(0xFF8E8E93),
                    ),
                  ),
              ],
            ),
          ),
          IconButton(
            icon: const Icon(Icons.close, size: 20, color: Color(0xFFC7C7CC)),
            onPressed: onClear,
            tooltip: 'Clear file',
          ),
        ],
      ),
    );
  }
}

// ---------------------------------------------------------------------------

class _ImporterDropdown extends StatelessWidget {
  final List<Importer> importers;
  final String? value;
  final ValueChanged<String?> onChanged;

  const _ImporterDropdown({
    required this.importers,
    required this.value,
    required this.onChanged,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 16),
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
      decoration: _cardDecoration,
      child: DropdownButtonHideUnderline(
        child: DropdownButton<String>(
          isExpanded: true,
          hint: const Text(
            'Select importer',
            style: TextStyle(color: Color(0xFFC7C7CC)),
          ),
          value: value,
          onChanged: onChanged,
          items: importers
              .map(
                (i) => DropdownMenuItem(
                  value: i.pluginName,
                  child: Text(i.displayName),
                ),
              )
              .toList(),
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------

class _ResultCard extends StatelessWidget {
  final ImportResult result;

  const _ResultCard({required this.result});

  @override
  Widget build(BuildContext context) {
    final hasAnyEntities = result.entities.isNotEmpty;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
          child: Row(
            children: [
              Icon(
                result.hasErrors
                    ? Icons.warning_amber_rounded
                    : Icons.check_circle_outline,
                color: result.hasErrors
                    ? const Color(0xFFFF9500)
                    : const Color(0xFF34C759),
                size: 22,
              ),
              const SizedBox(width: 8),
              Text(
                result.hasErrors
                    ? 'Import complete with errors'
                    : 'Import complete',
                style: const TextStyle(
                  fontSize: 17,
                  fontWeight: FontWeight.w600,
                  color: Color(0xFF1C1C1E),
                ),
              ),
            ],
          ),
        ),
        if (hasAnyEntities)
          Container(
            margin: const EdgeInsets.symmetric(horizontal: 16),
            decoration: _cardDecoration,
            child: Column(
              children: [
                for (final entry in result.entities.entries)
                  _EntityRow(entityType: entry.key, counts: entry.value),
              ],
            ),
          ),
        if (result.warnings.isNotEmpty) ...[
          const SizedBox(height: 16),
          Container(
            margin: const EdgeInsets.symmetric(horizontal: 16),
            padding: const EdgeInsets.all(16),
            decoration: _cardDecoration,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    const Icon(
                      Icons.warning_amber_rounded,
                      size: 18,
                      color: Color(0xFFFF9500),
                    ),
                    const SizedBox(width: 6),
                    Text(
                      'Warnings (${result.warnings.length})',
                      style: const TextStyle(
                        fontSize: 15,
                        fontWeight: FontWeight.w600,
                        color: Color(0xFF1C1C1E),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                for (final w in result.warnings)
                  Padding(
                    padding: const EdgeInsets.only(top: 4),
                    child: Text(
                      w,
                      style: const TextStyle(
                        fontSize: 13,
                        color: Color(0xFF8E8E93),
                      ),
                    ),
                  ),
              ],
            ),
          ),
        ],
      ],
    );
  }
}

class _EntityRow extends StatelessWidget {
  final String entityType;
  final EntityCounts counts;

  const _EntityRow({required this.entityType, required this.counts});

  @override
  Widget build(BuildContext context) {
    final label = _label(entityType);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 14, 16, 0),
          child: Text(
            label,
            style: const TextStyle(
              fontSize: 13,
              fontWeight: FontWeight.w600,
              color: Color(0xFF8E8E93),
              letterSpacing: 0.5,
            ),
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 6, 16, 14),
          child: Row(
            children: [
              _CountChip(
                label: 'Created',
                count: counts.created,
                color: const Color(0xFF34C759),
              ),
              const SizedBox(width: 8),
              _CountChip(
                label: 'Duplicates',
                count: counts.duplicate,
                color: const Color(0xFF8E8E93),
              ),
              const SizedBox(width: 8),
              _CountChip(
                label: 'Errors',
                count: counts.errorCount,
                color: const Color(0xFFFF3B30),
              ),
            ],
          ),
        ),
        if (counts.errorExamples.isNotEmpty)
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 14),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: counts.errorExamples
                  .map(
                    (e) => Padding(
                      padding: const EdgeInsets.only(bottom: 4),
                      child: Text(
                        '↳ $e',
                        style: const TextStyle(
                          fontSize: 12,
                          color: Color(0xFFFF3B30),
                        ),
                      ),
                    ),
                  )
                  .toList(),
            ),
          ),
        const Divider(height: 1, color: Color(0xFFF2F2F7)),
      ],
    );
  }

  String _label(String type) {
    final s = type.replaceAll('_', ' ');
    return s.isEmpty ? s : '${s[0].toUpperCase()}${s.substring(1)}s';
  }
}

class _CountChip extends StatelessWidget {
  final String label;
  final int count;
  final Color color;

  const _CountChip({
    required this.label,
    required this.count,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          count.toString(),
          style: TextStyle(
            fontSize: 20,
            fontWeight: FontWeight.w600,
            color: count > 0 ? color : const Color(0xFFC7C7CC),
          ),
        ),
        Text(
          label,
          style: const TextStyle(fontSize: 11, color: Color(0xFF8E8E93)),
        ),
      ],
    );
  }
}
