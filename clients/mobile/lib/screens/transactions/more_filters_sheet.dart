import 'package:flutter/material.dart';
import '../../models/commodity.dart';
import '../../repositories/commodity_repository.dart';
import '../../widgets/filter_pill.dart';
import '../../widgets/filter_sheet_header.dart';
import 'transaction_filter.dart';

Future<TransactionFilter?> showMoreFiltersSheet(
  BuildContext context, {
  required TransactionFilter current,
  required CommodityRepository commodityRepository,
}) {
  return showModalBottomSheet<TransactionFilter>(
    context: context,
    isScrollControlled: true,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
    ),
    builder: (_) => MoreFiltersSheet(
      initial: current,
      commodityRepository: commodityRepository,
    ),
  );
}

class MoreFiltersSheet extends StatefulWidget {
  final TransactionFilter initial;
  final CommodityRepository commodityRepository;

  const MoreFiltersSheet({
    super.key,
    required this.initial,
    required this.commodityRepository,
  });

  @override
  State<MoreFiltersSheet> createState() => _MoreFiltersSheetState();
}

class _MoreFiltersSheetState extends State<MoreFiltersSheet> {
  late TransactionFilter _draft;
  List<Commodity> _commodities = [];
  bool _commoditiesLoading = true;

  @override
  void initState() {
    super.initState();
    _draft = widget.initial;
    _loadCommodities();
  }

  Future<void> _loadCommodities() async {
    final result = await widget.commodityRepository.getAllCommodities();
    if (!mounted) return;
    setState(() {
      _commoditiesLoading = false;
      if (result.data != null) _commodities = result.data!;
    });
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.only(top: 8, bottom: 16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            FilterSheetHeader(
              title: 'More filters',
              onReset: () => Navigator.pop(
                context,
                widget.initial.copyWith(currency: null, lastImportOnly: false),
              ),
              onApply: () => Navigator.pop(context, _draft),
            ),

            // Last import toggle
            InkWell(
              onTap: () => setState(() {
                _draft = _draft.copyWith(
                  lastImportOnly: !_draft.lastImportOnly,
                );
              }),
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: 16,
                  vertical: 10,
                ),
                child: Row(
                  children: [
                    const Text(
                      'Last import',
                      style: TextStyle(fontSize: 15, color: Color(0xFF1C1C1E)),
                    ),
                    const Spacer(),
                    Switch.adaptive(
                      value: _draft.lastImportOnly,
                      onChanged: (v) => setState(
                        () => _draft = _draft.copyWith(lastImportOnly: v),
                      ),
                    ),
                  ],
                ),
              ),
            ),
            const Divider(height: 1, color: Color(0xFFE5E5EA)),

            // Commodity section
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    'Commodity',
                    style: TextStyle(fontSize: 15, color: Color(0xFF1C1C1E)),
                  ),
                  const SizedBox(height: 8),
                  _commoditiesLoading
                      ? const SizedBox(
                          height: 32,
                          child: Center(
                            child: SizedBox(
                              width: 16,
                              height: 16,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            ),
                          ),
                        )
                      : Wrap(
                          spacing: 8,
                          runSpacing: 8,
                          children: [
                            FilterPill(
                              label: 'Any commodity',
                              selected: _draft.currency == null,
                              onTap: () => setState(
                                () => _draft = _draft.copyWith(currency: null),
                              ),
                            ),
                            for (final commodity in _commodities)
                              FilterPill(
                                label: commodity.symbol,
                                selected: _draft.currency == commodity.symbol,
                                onTap: () => setState(
                                  () => _draft = _draft.copyWith(
                                    currency: commodity.symbol,
                                  ),
                                ),
                              ),
                          ],
                        ),
                ],
              ),
            ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
  }
}
