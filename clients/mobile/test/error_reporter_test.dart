import 'package:flutter_test/flutter_test.dart';
import 'package:family_ledger_mobile/core/api_error.dart';
import 'package:family_ledger_mobile/core/error_reporter.dart';

void main() {
  test('starts with no error', () {
    expect(ErrorReporter().value, isNull);
  });

  test('report sets the value and notifies listeners', () {
    final reporter = ErrorReporter();
    var notified = false;
    reporter.addListener(() => notified = true);

    reporter.report(const NetworkError('down'));

    expect(reporter.value, const NetworkError('down'));
    expect(notified, isTrue);
  });

  test('report(null) clears the value, same as clear()', () {
    final reporter = ErrorReporter()..report(const AuthError());

    reporter.report(null);

    expect(reporter.value, isNull);
  });

  test('clear resets the value to null', () {
    final reporter = ErrorReporter()..report(const AuthError());

    reporter.clear();

    expect(reporter.value, isNull);
  });
}
