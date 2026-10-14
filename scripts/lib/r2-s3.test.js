#!/usr/bin/env node
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  R2Client,
  canonicalQueryString,
  parseListObjectsV2,
  signRequest,
  uriEncode,
} from "./r2-s3.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

// Test vectors from the AWS "Signature Calculations for the Authorization
// Header" (S3 SigV4) documentation.
const AWS_EXAMPLE = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  region: "us-east-1",
  host: "examplebucket.s3.amazonaws.com",
  now: new Date("2013-05-24T00:00:00Z"),
};

function signature(headers) {
  return /Signature=([0-9a-f]+)/.exec(headers.authorization)[1];
}

describe("r2-s3", () => {
  it("matches the AWS GET object example", () => {
    const headers = signRequest({
      ...AWS_EXAMPLE,
      method: "GET",
      path: "/test.txt",
      headers: { Range: "bytes=0-9" },
    });
    assert.equal(
      signature(headers),
      "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
    assert.match(
      headers.authorization,
      /SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,/,
    );
  });

  it("matches the AWS list objects example", () => {
    const headers = signRequest({
      ...AWS_EXAMPLE,
      method: "GET",
      path: "/",
      query: { "max-keys": "2", prefix: "J" },
    });
    assert.equal(
      signature(headers),
      "34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7",
    );
  });

  it("sends the same RFC 3986 query string it signs", async () => {
    assert.equal(
      canonicalQueryString({ prefix: "a b", "continuation-token": "x*(y)+/=" }),
      "continuation-token=x%2A%28y%29%2B%2F%3D&prefix=a%20b",
    );
    let sent;
    globalThis.fetch = async (url) => {
      sent = new URL(url);
      return new Response("<IsTruncated>false</IsTruncated>");
    };
    const client = new R2Client({
      accountId: "acct",
      accessKeyId: "id",
      secretAccessKey: "secret",
      bucket: "bucket",
    });
    await client.request("GET", "", { query: { prefix: "a b*" } });
    assert.equal(sent.search, "?prefix=a%20b%2A");
  });

  it("encodes paths per RFC 3986", () => {
    assert.equal(uriEncode("a b/c*(d)", true), "a%20b/c%2A%28d%29");
    assert.equal(uriEncode("a/b"), "a%2Fb");
  });

  it("parses paginated listings", () => {
    const page = parseListObjectsV2(`<?xml version="1.0"?>
      <ListBucketResult>
        <IsTruncated>true</IsTruncated>
        <Contents><Key>a/1&amp;2.gz</Key><Size>10</Size></Contents>
        <Contents><Key>a/3.gz</Key><Size>20</Size></Contents>
        <NextContinuationToken>tok=</NextContinuationToken>
      </ListBucketResult>`);
    assert.deepEqual(page, {
      objects: [
        { key: "a/1&2.gz", size: 10 },
        { key: "a/3.gz", size: 20 },
      ],
      nextToken: "tok=",
    });
    assert.equal(
      parseListObjectsV2("<IsTruncated>false</IsTruncated>").nextToken,
      null,
    );
  });

  it("follows continuation tokens and returns null for missing objects", async () => {
    const urls = [];
    globalThis.fetch = async (url, options) => {
      urls.push(String(url));
      assert.match(options.headers.authorization, /^AWS4-HMAC-SHA256 /);
      const { searchParams, pathname } = new URL(url);
      if (pathname === "/bucket/missing") {
        return new Response("", { status: 404 });
      }
      if (!searchParams.has("continuation-token")) {
        return new Response(
          "<IsTruncated>true</IsTruncated><Contents><Key>p/1</Key><Size>1</Size></Contents><NextContinuationToken>t2</NextContinuationToken>",
        );
      }
      return new Response(
        "<IsTruncated>false</IsTruncated><Contents><Key>p/2</Key><Size>2</Size></Contents>",
      );
    };
    const client = new R2Client({
      accountId: "acct",
      accessKeyId: "id",
      secretAccessKey: "secret",
      bucket: "bucket",
    });
    const objects = await client.listObjects("p/");
    assert.deepEqual(
      objects.map((o) => o.key),
      ["p/1", "p/2"],
    );
    assert.ok(
      urls[0].startsWith("https://acct.r2.cloudflarestorage.com/bucket?"),
    );
    assert.equal(await client.getObject("missing"), null);
  });
});
