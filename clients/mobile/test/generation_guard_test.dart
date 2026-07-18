import 'package:flutter_test/flutter_test.dart';
import 'package:family_ledger_mobile/core/generation_guard.dart';

void main() {
  test('hasStarted is false until the first start()', () {
    final guard = GenerationGuard();
    expect(guard.hasStarted, isFalse);
    guard.start();
    expect(guard.hasStarted, isTrue);
  });

  test('a token is current until a newer one starts', () {
    final guard = GenerationGuard();
    final first = guard.start();
    expect(guard.isCurrent(first), isTrue);

    final second = guard.start();
    expect(guard.isCurrent(first), isFalse);
    expect(guard.isCurrent(second), isTrue);
  });

  test('an unstarted token (0) is never current once anything has started', () {
    final guard = GenerationGuard();
    guard.start();
    expect(guard.isCurrent(0), isFalse);
  });
}
