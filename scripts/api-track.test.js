#!/usr/bin/env node
/**
 * Tests for /api/track endpoint
 *
 * These tests validate the API contract and behavior of the track endpoint
 * by testing the handler logic with mocked dependencies.
 */
import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert";

/**
 * Mock request factory
 */
function createMockRequest(body, options = {}) {
  // Store headers with lowercase keys for case-insensitive lookup (per HTTP spec)
  const headers = new Map(
    Object.entries(options.headers || {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    json: async () => body,
    headers: {
      get: (name) => headers.get(name.toLowerCase()) || null,
    },
  };
}

/**
 * Mock runtime/locals factory
 */
function createMockLocals(overrides = {}) {
  const mockDb = {
    select: () => mockDb,
    from: () => mockDb,
    where: () => mockDb,
    limit: () => mockDb,
    get: async () => null,
    insert: () => mockDb,
    values: () => mockDb,
    onConflictDoNothing: () => mockDb,
    run: async () => ({ rowsAffected: 1 }),
  };

  return {
    runtime: {
      env: {
        API_SECRET: "test-secret",
        ANALYTICS_DB: {},
        TELEMETRY_PIPELINE: null,
        ...overrides.env,
      },
      ctx: {
        waitUntil: () => {},
      },
    },
  };
}

/**
 * Track endpoint handler (simplified version for testing)
 * This mimics the logic in web/src/pages/api/track.ts
 */
async function handleTrackRequest(request, locals, deps = {}) {
  const {
    hashIP = async () => "test-hash",
    trackDownload = async () => ({ deduplicated: false }),
  } = deps;

  try {
    const body = await request.json();

    // Validate required fields (matches real implementation)
    // Note: !body.tool catches both missing and empty string cases since !"" is true
    if (!body.tool || !body.version) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: tool, version" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // Track the download
    const ipHash = await hashIP("127.0.0.1", locals.runtime.env.API_SECRET);
    const result = await trackDownload(
      body.tool,
      body.version,
      ipHash,
      body.os || null,
      body.arch || null,
      body.full || null,
    );

    return new Response(
      JSON.stringify({
        success: true,
        deduplicated: result.deduplicated,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    return new Response(JSON.stringify({ error: "Failed to track download" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

describe("/api/track endpoint", () => {
  describe("request validation", () => {
    it("should reject requests missing tool field", async () => {
      const request = createMockRequest({ version: "1.0.0" });
      const locals = createMockLocals();

      const response = await handleTrackRequest(request, locals);
      const body = JSON.parse(await response.text());

      assert.strictEqual(response.status, 400);
      assert.ok(body.error.includes("Missing required fields"));
    });

    it("should reject requests missing version field", async () => {
      const request = createMockRequest({ tool: "node" });
      const locals = createMockLocals();

      const response = await handleTrackRequest(request, locals);
      const body = JSON.parse(await response.text());

      assert.strictEqual(response.status, 400);
      assert.ok(body.error.includes("Missing required fields"));
    });

    it("should reject requests with empty tool", async () => {
      const request = createMockRequest({ tool: "", version: "1.0.0" });
      const locals = createMockLocals();

      const response = await handleTrackRequest(request, locals);
      const body = JSON.parse(await response.text());

      assert.strictEqual(response.status, 400);
      assert.ok(body.error.includes("Missing required fields"));
    });

    it("should reject requests with empty version", async () => {
      const request = createMockRequest({ tool: "node", version: "" });
      const locals = createMockLocals();

      const response = await handleTrackRequest(request, locals);
      const body = JSON.parse(await response.text());

      assert.strictEqual(response.status, 400);
      assert.ok(body.error.includes("Missing required fields"));
    });
  });

  describe("successful tracking", () => {
    it("should track a basic download request", async () => {
      const request = createMockRequest({
        tool: "node",
        version: "20.10.0",
      });
      const locals = createMockLocals();
      let trackedData = null;

      const response = await handleTrackRequest(request, locals, {
        trackDownload: async (tool, version, ipHash, os, arch, full) => {
          trackedData = { tool, version, ipHash, os, arch, full };
          return { deduplicated: false };
        },
      });

      const body = JSON.parse(await response.text());

      assert.strictEqual(response.status, 200);
      assert.strictEqual(body.success, true);
      assert.strictEqual(body.deduplicated, false);
      assert.strictEqual(trackedData.tool, "node");
      assert.strictEqual(trackedData.version, "20.10.0");
    });

    it("should track a download with optional os/arch fields", async () => {
      const request = createMockRequest({
        tool: "node",
        version: "20.10.0",
        os: "linux",
        arch: "x64",
      });
      const locals = createMockLocals();
      let trackedData = null;

      const response = await handleTrackRequest(request, locals, {
        trackDownload: async (tool, version, ipHash, os, arch, full) => {
          trackedData = { tool, version, ipHash, os, arch, full };
          return { deduplicated: false };
        },
      });

      const body = JSON.parse(await response.text());

      assert.strictEqual(response.status, 200);
      assert.strictEqual(trackedData.os, "linux");
      assert.strictEqual(trackedData.arch, "x64");
    });

    it("should track a download with full backend identifier", async () => {
      const request = createMockRequest({
        tool: "act",
        version: "0.2.60",
        full: "aqua:nektos/act",
      });
      const locals = createMockLocals();
      let trackedData = null;

      const response = await handleTrackRequest(request, locals, {
        trackDownload: async (tool, version, ipHash, os, arch, full) => {
          trackedData = { tool, version, ipHash, os, arch, full };
          return { deduplicated: false };
        },
      });

      const body = JSON.parse(await response.text());

      assert.strictEqual(response.status, 200);
      assert.strictEqual(trackedData.full, "aqua:nektos/act");
    });

    it("should indicate when download is deduplicated", async () => {
      const request = createMockRequest({
        tool: "node",
        version: "20.10.0",
      });
      const locals = createMockLocals();

      const response = await handleTrackRequest(request, locals, {
        trackDownload: async () => ({ deduplicated: true }),
      });

      const body = JSON.parse(await response.text());

      assert.strictEqual(response.status, 200);
      assert.strictEqual(body.success, true);
      assert.strictEqual(body.deduplicated, true);
    });
  });

  describe("error handling", () => {
    it("should return 500 when trackDownload throws", async () => {
      const request = createMockRequest({
        tool: "node",
        version: "20.10.0",
      });
      const locals = createMockLocals();

      const response = await handleTrackRequest(request, locals, {
        trackDownload: async () => {
          throw new Error("Database error");
        },
      });

      const body = JSON.parse(await response.text());

      assert.strictEqual(response.status, 500);
      assert.ok(body.error.includes("Failed to track"));
    });

    it("should return 500 when request body is invalid JSON", async () => {
      const request = {
        json: async () => {
          throw new SyntaxError("Unexpected token");
        },
        headers: {
          get: () => null,
        },
      };
      const locals = createMockLocals();

      const response = await handleTrackRequest(request, locals);

      assert.strictEqual(response.status, 500);
    });
  });

  describe("response format", () => {
    it("should return JSON content type", async () => {
      const request = createMockRequest({
        tool: "node",
        version: "20.10.0",
      });
      const locals = createMockLocals();

      const response = await handleTrackRequest(request, locals);

      assert.strictEqual(
        response.headers.get("Content-Type"),
        "application/json",
      );
    });

    it("should return valid JSON in success response", async () => {
      const request = createMockRequest({
        tool: "node",
        version: "20.10.0",
      });
      const locals = createMockLocals();

      const response = await handleTrackRequest(request, locals);
      const body = JSON.parse(await response.text());

      assert.ok(typeof body === "object");
      assert.ok("success" in body);
      assert.ok("deduplicated" in body);
    });

    it("should return valid JSON in error response", async () => {
      const request = createMockRequest({ tool: "node" }); // missing version
      const locals = createMockLocals();

      const response = await handleTrackRequest(request, locals);
      const body = JSON.parse(await response.text());

      assert.ok(typeof body === "object");
      assert.ok("error" in body);
    });
  });
});
