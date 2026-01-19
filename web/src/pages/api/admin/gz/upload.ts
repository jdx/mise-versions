import type { APIRoute } from "astro";
import {
  jsonResponse,
  errorResponse,
  requireApiAuth,
} from "../../../../lib/api";

interface UploadRequest {
  filename: string;
  data: string; // base64-encoded gzip data
}

// POST /api/admin/gz/upload - Upload .gz file to R2
export const POST: APIRoute = async ({ request, locals }) => {
  const runtime = locals.runtime;

  // Check API auth (Bearer token for CI)
  const authError = requireApiAuth(request, runtime.env.API_SECRET);
  if (authError) {
    return authError;
  }

  let body: UploadRequest;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  if (!body.filename || !body.data) {
    return errorResponse("filename and data are required", 400);
  }

  // Validate filename (must be python-precompiled*.gz)
  if (!/^python-precompiled[\w\-]*\.gz$/.test(body.filename)) {
    return errorResponse(
      "Invalid filename - must be python-precompiled*.gz",
      400,
    );
  }

  try {
    // Decode base64 data
    const binaryData = Uint8Array.from(atob(body.data), (c) => c.charCodeAt(0));

    // Upload to R2 bucket under tools/ prefix
    const bucket = runtime.env.DATA_BUCKET;
    const key = `tools/${body.filename}`;

    await bucket.put(key, binaryData, {
      httpMetadata: {
        contentType: "application/gzip",
      },
    });

    return jsonResponse({
      success: true,
      key,
      size: binaryData.length,
    });
  } catch (error: any) {
    console.error("Error uploading to R2:", error);
    return errorResponse(`Failed to upload: ${error.message}`, 500);
  }
};
