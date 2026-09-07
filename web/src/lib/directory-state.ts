export type SortKey = "name" | "downloads" | "updated";
export interface DirectoryState {
  page: number;
  search: string;
  sort: SortKey;
  backends: string[];
}
export function readDirectoryState(query: string): DirectoryState {
  const params = new URLSearchParams(query);
  const sort = params.get("sort");
  const page = Number(params.get("page"));
  return {
    page: Number.isInteger(page) && page > 0 ? page : 1,
    search: params.get("q") || "",
    sort: sort === "name" || sort === "updated" ? sort : "downloads",
    backends: (params.get("backends") || "").split(",").filter(Boolean),
  };
}
export function directoryQuery(state: Partial<DirectoryState>): string {
  const params = new URLSearchParams();
  if (state.page && state.page > 1) params.set("page", String(state.page));
  if (state.search?.trim()) params.set("q", state.search.trim());
  if (state.sort && state.sort !== "downloads") params.set("sort", state.sort);
  if (state.backends?.length) params.set("backends", state.backends.join(","));
  return params.toString();
}
