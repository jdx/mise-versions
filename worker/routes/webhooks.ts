// Webhook routes: /webhooks/*
import { Env, CORS_HEADERS } from "../shared";

// Verify GitHub webhook signature using HMAC-SHA256
async function verifyWebhookSignature(
  payload: string,
  signature: string | null,
  secret: string
): Promise<boolean> {
  if (!signature || !signature.startsWith("sha256=")) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  const expectedSig =
    "sha256=" +
    Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

  // Constant-time comparison to prevent timing attacks
  if (signature.length !== expectedSig.length) return false;
  let result = 0;
  for (let i = 0; i < signature.length; i++) {
    result |= signature.charCodeAt(i) ^ expectedSig.charCodeAt(i);
  }
  return result === 0;
}

// POST /webhooks/github - GitHub webhooks handler
// Purges cache for updated tool version files
export async function handleGitHubWebhook(
  request: Request,
  env: Env
): Promise<Response> {
  const payload = await request.text();
  const eventType = request.headers.get("x-github-event");
  const signature = request.headers.get("x-hub-signature-256");

  // Verify webhook signature
  if (!(await verifyWebhookSignature(payload, signature, env.GITHUB_WEBHOOK_SECRET))) {
    console.error("Invalid webhook signature");
    return new Response("Invalid signature", { status: 401 });
  }

  console.log(`Webhook received: ${eventType} event`);

  // Only process push events
  if (eventType !== "push") {
    return new Response("Webhook processed", {
      status: 200,
      headers: CORS_HEADERS,
    });
  }

  try {
    const data = JSON.parse(payload) as {
      commits?: Array<{
        added?: string[];
        modified?: string[];
        removed?: string[];
      }>;
    };

    // Collect all modified files from all commits
    const modifiedFiles = new Set<string>();
    for (const commit of data.commits || []) {
      for (const file of commit.added || []) modifiedFiles.add(file);
      for (const file of commit.modified || []) modifiedFiles.add(file);
      for (const file of commit.removed || []) modifiedFiles.add(file);
    }

    // Filter to docs/ files (tool version files) and purge their cache
    const cache = caches.default;
    const baseUrl = new URL(request.url).origin;
    let purged = 0;

    for (const file of modifiedFiles) {
      // docs/node -> /data/node, docs/python/versions.txt -> /data/python/versions.txt
      if (file.startsWith("docs/")) {
        const dataPath = file.slice(5); // Remove "docs/"
        const cacheUrl = `${baseUrl}/data/${dataPath}`;
        const deleted = await cache.delete(new Request(cacheUrl));
        if (deleted) {
          console.log(`Purged cache: ${cacheUrl}`);
          purged++;
        }
      }
    }

    console.log(`Cache purge complete: ${purged} URLs purged`);

    return new Response(JSON.stringify({ purged, files: modifiedFiles.size }), {
      status: 200,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Webhook processing error:", error);
    return new Response("Webhook processed with errors", {
      status: 200,
      headers: CORS_HEADERS,
    });
  }
}
