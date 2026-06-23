import 'package:flutter/material.dart';

class AppLogo extends StatelessWidget {
  final double size;
  const AppLogo({super.key, this.size = 28});

  @override
  Widget build(BuildContext context) {
    return CustomPaint(size: Size(size, size), painter: _LogoPainter());
  }
}

class _LogoPainter extends CustomPainter {
  static const _blue = Color(0xFF64B5F6);
  static const _white = Colors.white;

  @override
  void paint(Canvas canvas, Size s) {
    final w = s.width;
    final h = s.height;

    final bluePaint = Paint()..color = _blue;
    final whitePaint = Paint()..color = _white;

    // Blue rounded-square background.
    canvas.drawRRect(
      RRect.fromRectAndRadius(
        Rect.fromLTWH(0, 0, w, h),
        Radius.circular(w * 0.22),
      ),
      bluePaint,
    );

    // House: white roof triangle.
    final pad = w * 0.12;
    final peakY = h * 0.14;
    final roofBaseY = h * 0.50;
    final roofPath = Path()
      ..moveTo(w / 2, peakY)
      ..lineTo(w - pad, roofBaseY)
      ..lineTo(pad, roofBaseY)
      ..close();
    canvas.drawPath(roofPath, whitePaint);

    // House: white body rectangle.
    final bodyPad = w * 0.17;
    final bodyBottom = h * 0.88;
    canvas.drawRect(
      Rect.fromLTRB(bodyPad, roofBaseY, w - bodyPad, bodyBottom),
      whitePaint,
    );

    // Three ascending blue bars (negative space in white body).
    final barW = w * 0.10;
    final barGap = w * 0.055;
    final totalW = 3 * barW + 2 * barGap;
    final barX0 = (w - totalW) / 2;
    final barBottom = bodyBottom - h * 0.04;
    final barHeights = [h * 0.16, h * 0.24, h * 0.32];
    final rr = Radius.circular(w * 0.018);

    for (var i = 0; i < 3; i++) {
      final x = barX0 + i * (barW + barGap);
      final bh = barHeights[i];
      canvas.drawRRect(
        RRect.fromRectAndRadius(Rect.fromLTWH(x, barBottom - bh, barW, bh), rr),
        bluePaint,
      );
    }
  }

  @override
  bool shouldRepaint(covariant CustomPainter old) => false;
}
