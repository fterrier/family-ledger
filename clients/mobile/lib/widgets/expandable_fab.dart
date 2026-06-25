import 'package:flutter/material.dart';

class ExpandableFab extends StatefulWidget {
  const ExpandableFab({
    super.key,
    required this.onAddTransaction,
    required this.onImport,
  });

  final VoidCallback onAddTransaction;
  final VoidCallback onImport;

  @override
  State<ExpandableFab> createState() => _ExpandableFabState();
}

class _ExpandableFabState extends State<ExpandableFab>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;
  late final CurvedAnimation _animation;

  final _primaryKey = GlobalKey();

  bool _isImportHovered = false;
  Offset? _pointerDownPosition;
  Offset? _primaryCenterGlobal;
  bool _farFromOrigin = false;

  static const double _kDragThreshold = 20.0;
  static const double _kDragThresholdSq = _kDragThreshold * _kDragThreshold;
  // Import button center is this many pixels above the primary FAB center:
  // half-primary (28) + gap (8) + half-import (20) = 56px.
  static const double _kImportOffsetY = 56.0;
  static const double _kImportHitRadius = 24.0; // slightly generous
  static const double _kImportHitRadiusSq =
      _kImportHitRadius * _kImportHitRadius;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 200),
    );
    _animation = CurvedAnimation(
      parent: _controller,
      curve: Curves.fastOutSlowIn,
    );
  }

  @override
  void dispose() {
    _animation.dispose();
    _controller.dispose();
    super.dispose();
  }

  void _onPointerDown(PointerDownEvent event) {
    _pointerDownPosition = event.position;
    _farFromOrigin = false;
    final box = _primaryKey.currentContext?.findRenderObject() as RenderBox?;
    _primaryCenterGlobal = box?.localToGlobal(box.size.center(Offset.zero));
    _controller.forward();
  }

  void _onPointerMove(PointerMoveEvent event) {
    if (!_farFromOrigin) {
      final distSq = (event.position - _pointerDownPosition!).distanceSquared;
      if (distSq > _kDragThresholdSq) _farFromOrigin = true;
    }
    final isOver = _isOverImport(event.position);
    if (isOver != _isImportHovered) {
      setState(() => _isImportHovered = isOver);
    }
  }

  void _onPointerUp(PointerUpEvent event) {
    final wasHovered = _isImportHovered;
    final wasFar = _farFromOrigin;
    _collapse();
    if (wasHovered) {
      widget.onImport();
    } else if (!wasFar) {
      widget.onAddTransaction();
    }
  }

  void _onPointerCancel(PointerCancelEvent event) => _collapse();

  void _collapse() {
    if (_isImportHovered) setState(() => _isImportHovered = false);
    _controller.reverse();
    _pointerDownPosition = null;
    _primaryCenterGlobal = null;
    _farFromOrigin = false;
  }

  bool _isOverImport(Offset globalPos) {
    if (_primaryCenterGlobal == null) return false;
    final importCenter =
        _primaryCenterGlobal! - const Offset(0, _kImportOffsetY);
    return (globalPos - importCenter).distanceSquared < _kImportHitRadiusSq;
  }

  @override
  Widget build(BuildContext context) {
    return Stack(
      clipBehavior: Clip.none,
      alignment: Alignment.bottomRight,
      children: [
        Positioned(
          bottom: 64, // 56 (FAB height) + 8 (gap)
          right: 0,
          child: ScaleTransition(
            key: const Key('fab_import_scale'),
            scale: _animation,
            alignment: Alignment.bottomCenter,
            child: FadeTransition(
              opacity: _animation,
              child: SizedBox(
                width: 56, // match primary FAB width so Center aligns correctly
                child: Center(
                  child: IgnorePointer(
                    child: FloatingActionButton(
                      heroTag: 'fab_import',
                      onPressed: null,
                      mini: true,
                      backgroundColor: _isImportHovered
                          ? const Color(0xFF1A73E8)
                          : Colors.white,
                      foregroundColor: _isImportHovered
                          ? Colors.white
                          : const Color(0xFF1A73E8),
                      elevation: 2,
                      tooltip: 'Import',
                      child: const Icon(Icons.upload_file_outlined),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
        Listener(
          behavior: HitTestBehavior.opaque,
          onPointerDown: _onPointerDown,
          onPointerMove: _onPointerMove,
          onPointerUp: _onPointerUp,
          onPointerCancel: _onPointerCancel,
          child: FloatingActionButton(
            key: _primaryKey,
            heroTag: 'fab_add',
            onPressed: null,
            backgroundColor: const Color(0xFF1A73E8),
            foregroundColor: Colors.white,
            child: const Icon(Icons.add),
          ),
        ),
      ],
    );
  }
}
