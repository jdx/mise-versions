import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

type Handler = (method: string, body: { tool?: string } | null) => Response;

const session = new Map<string, string>();
let handler: Handler = () => new Response("{}", { status: 500 });
let signInUrl: string | null = null;
let imports = 0;

beforeEach(() => {
  session.clear();
  signInUrl = null;
  Object.assign(globalThis, {
    window: {
      location: {
        pathname: "/tools/node",
        search: "",
        assign: (url: string) => {
          signInUrl = url;
        },
      },
    },
    sessionStorage: {
      getItem: (k: string) => session.get(k) ?? null,
      setItem: (k: string, v: string) => void session.set(k, v),
      removeItem: (k: string) => void session.delete(k),
    },
    fetch: async (_url: string, init?: RequestInit) =>
      handler(
        init?.method ?? "GET",
        init?.body ? JSON.parse(String(init.body)) : null,
      ),
  });
});

// The store keeps module-level state, so every test gets a fresh copy.
async function freshStore() {
  return import(`./favorites-store.ts?case=${imports++}`) as Promise<
    typeof import("./favorites-store")
  >;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status });

test("a failed load leaves the stars clickable and a click retries", async () => {
  const store = await freshStore();
  handler = () => json({}, 500);
  await store.ensureLoaded();
  assert.equal(store.favoritesSnapshot().status, "error");

  handler = () => json({ favorites: ["node"] });
  await store.toggleFavorite("node");
  assert.equal(store.favoritesSnapshot().status, "ready");
  assert.ok(store.favoritesSnapshot().tools.has("node"));
});

test("anonymous clicks remember the tool and start sign-in", async () => {
  const store = await freshStore();
  handler = () => json({ error: "no" }, 401);
  await store.ensureLoaded();
  await store.toggleFavorite("go");
  assert.equal(session.get("mise-pending-favorite"), "go");
  assert.match(signInUrl ?? "", /^\/api\/auth\/login\?return_to=/);
});

test("confirmed favorites only change once the server accepts the write", async () => {
  const store = await freshStore();
  handler = (method) =>
    method === "GET" ? json({ favorites: [] }) : json({ ok: true }, 201);
  await store.ensureLoaded();

  const pending = store.toggleFavorite("node");
  assert.ok(store.favoritesSnapshot().tools.has("node"));
  assert.ok(!store.favoritesSnapshot().confirmed.has("node"));
  await pending;
  assert.ok(store.favoritesSnapshot().confirmed.has("node"));
});

test("two quick clicks that both fail end on what the server has", async () => {
  const store = await freshStore();
  handler = (method) =>
    method === "GET" ? json({ favorites: [] }) : json({ error: "x" }, 500);
  await store.ensureLoaded();

  const first = store.toggleFavorite("node"); // add
  const second = store.toggleFavorite("node"); // remove
  await Promise.all([first, second]);
  assert.ok(!store.favoritesSnapshot().tools.has("node"));
  assert.ok(!store.favoritesSnapshot().confirmed.has("node"));
});

test("writes for one tool are sent in click order", async () => {
  const store = await freshStore();
  const calls: string[] = [];
  handler = (method, body) => {
    if (method === "GET") return json({ favorites: [] });
    calls.push(`${method} ${body?.tool}`);
    return json({ ok: true });
  };
  await store.ensureLoaded();

  await Promise.all([
    store.toggleFavorite("node"),
    store.toggleFavorite("node"),
  ]);
  assert.deepEqual(calls, ["PUT node", "DELETE node"]);
  assert.ok(!store.favoritesSnapshot().tools.has("node"));
});

test("a pending favorite is applied after sign-in and then forgotten", async () => {
  const store = await freshStore();
  session.set("mise-pending-favorite", "go");
  handler = (method) =>
    method === "GET" ? json({ favorites: [] }) : json({ ok: true }, 201);
  await store.ensureLoaded();
  assert.ok(store.favoritesSnapshot().confirmed.has("go"));
  assert.equal(session.has("mise-pending-favorite"), false);
});

test("a pending favorite survives a failed save for the next visit", async () => {
  const store = await freshStore();
  session.set("mise-pending-favorite", "go");
  handler = (method) =>
    method === "GET" ? json({ favorites: [] }) : json({ error: "x" }, 500);
  await store.ensureLoaded();
  assert.ok(!store.favoritesSnapshot().tools.has("go"));
  assert.equal(session.get("mise-pending-favorite"), "go");
});

test("removing a favorite whose post-sign-in save failed does not bring it back", async () => {
  const store = await freshStore();
  session.set("mise-pending-favorite", "go");

  // Hold the first save open so the visitor can click while it is in flight.
  let failFirstSave!: () => void;
  const firstSave = new Promise<void>((resolve) => (failFirstSave = resolve));
  let puts = 0;
  const gated = globalThis.fetch;
  Object.assign(globalThis, {
    fetch: async (url: string, init?: RequestInit) => {
      if (init?.method === "PUT" && puts++ === 0) {
        await firstSave;
        return json({ error: "x" }, 500);
      }
      return gated(url, init);
    },
  });
  handler = (method) =>
    method === "GET" ? json({ favorites: [] }) : json({ ok: true });

  const loaded = store.ensureLoaded();
  while (!store.favoritesSnapshot().tools.has("go")) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const removal = store.toggleFavorite("go"); // un-star while the save is pending
  failFirstSave();
  await Promise.all([loaded, removal]);
  assert.equal(session.has("mise-pending-favorite"), false);
  assert.ok(!store.favoritesSnapshot().tools.has("go"));
});

test("retrying after a failed load puts the store back in loading", async () => {
  const store = await freshStore();
  handler = () => json({}, 500);
  await store.ensureLoaded();

  let gets = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  Object.assign(globalThis, {
    fetch: async () => {
      gets++;
      await held;
      return json({ favorites: [] });
    },
  });
  const first = store.toggleFavorite("node");
  assert.equal(store.favoritesSnapshot().status, "loading");
  // A second click while the retry is in flight must not start another fetch.
  await store.toggleFavorite("go");
  release();
  await first;
  assert.equal(gets, 1);
  assert.equal(store.favoritesSnapshot().status, "ready");
});
