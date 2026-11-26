// Test helper: decode a D1 /query request body as if batchUpsert still bound
// one parameter per value, so tests can assert on flat params. batchUpsert
// sends a batch as a single JSON array of rows expanded with json_each.
export function decodeD1Body(body) {
  const request = JSON.parse(body);
  if (request.sql?.includes("FROM json_each(?)")) {
    return { ...request, params: JSON.parse(request.params[0]).flat() };
  }
  return request;
}
