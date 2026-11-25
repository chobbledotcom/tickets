import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { describe, it as test } from "@std/testing/bdd";
import { publishGuideAnimations } from "#scripts/guides/publish.ts";
import { CONFIG } from "../static-cdn-fixtures.ts";
import { writeGuideSession } from "./session-fixture.ts";

interface Uploaded {
  bytes: Uint8Array;
  contentType: string;
}

const recordingFetcher =
  (uploads: Map<string, Uploaded>): typeof fetch =>
  async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (request.method === "POST") {
      return new Response(null, { status: 204 });
    }
    const path = url.pathname.split("/static/")[1];
    if (path === undefined) throw new Error(`Unexpected URL ${url.href}`);
    if (request.method === "PUT") {
      uploads.set(path, {
        bytes: new Uint8Array(await request.arrayBuffer()),
        contentType: request.headers.get("content-type") ?? "",
      });
      return new Response(null, { status: 201 });
    }
    if (request.method === "POST") {
      return new Response(null, { status: 204 });
    }
    const uploaded = uploads.get(path);
    if (!uploaded) return new Response(null, { status: 404 });
    return new Response(Uint8Array.from(uploaded.bytes).buffer, {
      headers: { "content-type": uploaded.contentType },
    });
  };

describe("publishGuideAnimations", () => {
  test("uploads one content-addressed player for the guide", async () => {
    const root = await Deno.makeTempDir({ prefix: "guide-publish-test-" });
    try {
      const session = join(root, "session");
      await writeGuideSession(session, 2);
      const uploads = new Map<string, Uploaded>();

      const published = await publishGuideAnimations(CONFIG, {
        fetcher: recordingFetcher(uploads),
        fromSession: session,
        playerBundle: "console.log('player')",
        slug: "create-a-listing",
      });

      expect(published.hash).toMatch(/^[a-f0-9]{16}$/);
      expect(published.baseUrl).toBe(
        `https://assets.example.com/static/guides/${published.hash}`,
      );
      expect(published.slugs).toEqual(["create-a-listing"]);

      const basePath = `guides/${published.hash}`;
      expect([...uploads.keys()].sort()).toEqual(
        [
          `${basePath}/create-a-listing/frames/frame-00001.webp`,
          `${basePath}/create-a-listing/frames/frame-00002.webp`,
          `${basePath}/create-a-listing/index.html`,
          `${basePath}/create-a-listing/timeline.json`,
          `${basePath}/player.js`,
        ].sort(),
      );
      expect(uploads.get(`${basePath}/player.js`)?.contentType).toBe(
        "application/javascript; charset=utf-8",
      );
      expect(
        uploads.get(`${basePath}/create-a-listing/index.html`)?.contentType,
      ).toBe("text/html; charset=utf-8");

      const html = new TextDecoder().decode(
        uploads.get(`${basePath}/create-a-listing/index.html`)?.bytes,
      );
      assertStringIncludes(html, 'src="../player.js"');
      assert(!html.includes("guide.mp4"));
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
});
