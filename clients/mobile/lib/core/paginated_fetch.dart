import 'api_client.dart';
import 'result.dart';

Future<Result<List<T>>> paginatedFetch<T>(
  ApiClient client,
  String path,
  String itemsKey,
  T Function(Map<String, dynamic>) fromJson,
) async {
  final all = <T>[];
  String? pageToken;

  do {
    final params = <String, String>{'page_size': '200'};
    if (pageToken != null) params['page_token'] = pageToken;

    final result = await client.get(path, queryParams: params);
    if (result.error != null) return (data: null, error: result.error);

    final body = result.data!;
    all.addAll(
      (body[itemsKey] as List).map((e) => fromJson(e as Map<String, dynamic>)),
    );
    pageToken = body['next_page_token'] as String?;
  } while (pageToken != null);

  return (data: all, error: null);
}
