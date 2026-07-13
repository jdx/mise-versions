declare module "*web/dist/server/entry.mjs" {
  const worker: {
    fetch: ExportedHandlerFetchHandler<Env>;
  };

  export default worker;
}
