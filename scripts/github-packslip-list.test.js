import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

// Runs a route handler: `cloudflare:workers` resolves to a module whose `env`
// is globalThis.__env, and the Cache API is an in-memory map.
const WORKERS_STUB = `data:text/javascript,${encodeURIComponent(
  `export async function resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers") {
      return {
        url: "data:text/javascript,export const env = globalThis.__env;",
        shortCircuit: true,
      };
    }
    return next(specifier, context);
  }`,
)}`;
const REGISTER = `data:text/javascript,${encodeURIComponent(
  `import { register } from "node:module"; register(${JSON.stringify(WORKERS_STUB)});`,
)}`;

function runRouteTest(source) {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--import", REGISTER, "--input-type=module"],
    {
      cwd: new URL("..", import.meta.url),
      input: source,
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`.trim());
}

const ROUTE = `
  import assert from "node:assert/strict";
  const edge = new Map();
  globalThis.caches = {
    default: {
      match: async (request) => edge.get(request.url)?.clone(),
      put: async (request, response) => edge.set(request.url, response),
      delete: async (request) => edge.delete(request.url),
    },
  };
  const requests = [];
  let contents = () => new Response('{"message":"Not Found"}', { status: 404 });
  globalThis.fetch = async (url) => {
    url = String(url);
    requests.push(url);
    if (url === "https://api.github.com/repos/owner/repo") {
      return Response.json({ private: false, visibility: "public" });
    }
    if (url === "https://api.github.com/repos/owner/secret") {
      return Response.json({ private: true, visibility: "private" });
    }
    if (url.includes("/contents/")) return contents(url);
    return new Response('{"message":"Not Found"}', { status: 404 });
  };
  const kv = new Map();
  globalThis.__env = {
    DB: {},
    ANALYTICS_DB: {},
    GITHUB_CACHE: {
      get: async (key, type) =>
        kv.has(key) ? (type === "json" ? JSON.parse(kv.get(key)) : kv.get(key)) : null,
      put: async (key, value) => kv.set(key, value),
      delete: async (key) => kv.delete(key),
    },
  };
  const { GET } = await import(
    "./web/src/pages/api/github/repos/[owner]/[repo]/packslip-list/[...sub].ts"
  );
  const pending = [];
  const call = (sub, repo = "repo") =>
    GET({
      params: { owner: "owner", repo, sub },
      request: new Request(
        "https://mise-versions.jdx.dev/api/github/repos/owner/" + repo +
          "/packslip-list" + (sub ? "/" + sub : ""),
      ),
      locals: { cfContext: { waitUntil: (promise) => pending.push(promise) } },
    });
  const contentsRequests = () => requests.filter((url) => url.includes("/contents/"));
`;

test("a repository without a list is answered as having none, and the answer is cached", () => {
  runRouteTest(`${ROUTE}
    const response = await call(undefined);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.present, false);
    assert.ok(!Number.isNaN(Date.parse(body.fetched_at)));
    assert.deepEqual(contentsRequests(), [
      "https://api.github.com/repos/owner/repo/contents/.well-known/packslip.json",
    ]);
    assert.match(response.headers.get("cache-control"), /max-age=0, s-maxage=600/);
    await Promise.all(pending);

    // The second client never reaches GitHub.
    const again = await call(undefined);
    assert.equal((await again.json()).present, false);
    assert.equal(contentsRequests().length, 1);
  `);
});

test("a list is served with its exact text, from the subdirectory path for a monorepo project", () => {
  runRouteTest(`${ROUTE}
    const text = '{"payload":"caf\\u00e9 \\u2713"}\\n';
    const bytes = new TextEncoder().encode(text);
    contents = () =>
      Response.json({
        type: "file",
        encoding: "base64",
        // GitHub wraps base64 at 60 columns.
        content: btoa(String.fromCharCode(...bytes)).replace(/(.{20})/g, "$1\\n"),
      });
    const response = await call("tools/my-tool");
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.present, true);
    assert.equal(body.text, text);
    assert.deepEqual(contentsRequests(), [
      "https://api.github.com/repos/owner/repo/contents/.well-known/packslip/tools/my-tool.json",
    ]);
  `);
});

test("a leading byte-order mark stays in the text", () => {
  runRouteTest(`${ROUTE}
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("{}")]);
    contents = () =>
      Response.json({
        type: "file",
        encoding: "base64",
        content: btoa(String.fromCharCode(...bytes)),
      });
    const body = await (await call(undefined)).json();
    assert.equal(body.text, "\\ufeff{}");
  `);
});

test("a directory or symlink at the path is no list, and a file GitHub will not return whole is an error", () => {
  runRouteTest(`${ROUTE}
    contents = () => Response.json([{ type: "file", name: "x" }]);
    assert.equal((await (await call(undefined)).json()).present, false);

    contents = () => Response.json({ type: "symlink", target: "../x" });
    assert.equal((await (await call("a")).json()).present, false);

    contents = () => Response.json({ type: "file", encoding: "none", content: "" });
    assert.equal((await call("b")).status, 502);

    contents = () => new Response("boom", { status: 500 });
    const failed = await call("c");
    assert.equal(failed.status, 502);
    await Promise.all(pending);
    // An outage is never cached as "no list".
    contents = () => Response.json({ type: "file", encoding: "base64", content: btoa("{}") });
    assert.equal((await (await call("c")).json()).present, true);
  `);
});

test("a private repository and a bad path never reach the list", () => {
  runRouteTest(`${ROUTE}
    assert.equal((await call(undefined, "secret")).status, 404);
    assert.equal(contentsRequests().length, 0);

    for (const sub of ["..", "a/../b", "a%2", "a//b", "a b", ".", "%2e%2e/x"]) {
      assert.equal((await call(sub)).status, 400, sub);
    }
    assert.equal(contentsRequests().length, 0);
  `);
});
