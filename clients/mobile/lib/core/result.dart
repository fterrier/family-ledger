import 'api_error.dart';

typedef Result<T> = ({T? data, ApiError? error});

extension ResultExtension<T> on Result<T> {
  bool get isSuccess => error == null && data != null;
  bool get isError => error != null;
}
