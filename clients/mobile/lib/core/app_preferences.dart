import 'package:shared_preferences/shared_preferences.dart';

class AppPreferences {
  static const keyDefaultFrom = 'last_from_account_name';
  static const keyDefaultCurrency = 'default_currency';

  static Future<void> clear() async {
    final prefs = await SharedPreferences.getInstance();
    await Future.wait([
      prefs.remove(keyDefaultFrom),
      prefs.remove(keyDefaultCurrency),
    ]);
  }
}
