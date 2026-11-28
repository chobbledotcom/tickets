/**
 * The local guide video route: a development map names a recorded MP4 at a
 * site path, and the route serves it from `reports/guides/`. A published map
 * names absolute CDN URLs, so the route never reads a file for it.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { createApp, inProcess } from "#test/blackbox/driver.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withEnv } from "#test-utils/env.ts";

const VIDEO = new TextEncoder().encode("fake-mp4-bytes");
const GUIDES = "reports/guides";

const newSlug = (): string => `guide-${crypto.randomUUID()}`;
const guideDir = (slug: string): string => `${GUIDES}/${slug}`;
const localPath = (slug: string): string => `/guide-videos/${slug}`;

/** The map a development run hands the app for one recorded guide. */
const mapFor = (slug: string, video = localPath(slug)): string =>
  JSON.stringify({ [slug]: { video } });

/** Ask the app for one local video, as the modal does. */
const fetchVideo = (slug: string): Promise<Response> =>
  inProcess(
    new Request(`http://localhost${localPath(slug)}`, {
      headers: { host: "localhost" },
    }),
  );

describeWithEnv("local guide videos", { db: true }, () => {
  test("shows the camera link for a local video", async () => {
    using _env = withEnv({ GUIDE_VIDEOS: mapFor("create-a-listing") });
    const app = createApp(inProcess);
    await app.logIn();

    const page = await app.get("/admin/listing/new?template=custom");

    expectIncludesAll(page.html, [
      "data-guide-video",
      `href="${localPath("create-a-listing")}"`,
    ]);
  });

  test("serves the recorded MP4 that the map names", async () => {
    const slug = newSlug();
    await Deno.mkdir(guideDir(slug), { recursive: true });
    await Deno.writeFile(`${guideDir(slug)}/guide.mp4`, VIDEO);
    try {
      using _env = withEnv({ GUIDE_VIDEOS: mapFor(slug) });
      const response = await fetchVideo(slug);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("video/mp4");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(VIDEO);
    } finally {
      await Deno.remove(guideDir(slug), { recursive: true });
    }
  });

  test("answers 404 when the map names no video", async () => {
    using _env = withEnv({ GUIDE_VIDEOS: undefined });

    expect((await fetchVideo("create-a-listing")).status).toBe(404);
  });

  test("answers 404 when the map names a CDN video", async () => {
    const slug = newSlug();
    using _env = withEnv({
      GUIDE_VIDEOS: mapFor(slug, "https://cdn.example.com/guides/x.mp4"),
    });

    expect((await fetchVideo(slug)).status).toBe(404);
  });

  test("answers 404 when the recorder left no file", async () => {
    const slug = newSlug();
    using _env = withEnv({ GUIDE_VIDEOS: mapFor(slug) });

    expect((await fetchVideo(slug)).status).toBe(404);
  });

  test("fails loudly when the local path is not a directory", async () => {
    const slug = newSlug();
    await Deno.mkdir(GUIDES, { recursive: true });
    await Deno.writeFile(guideDir(slug), VIDEO);
    try {
      using _env = withEnv({ GUIDE_VIDEOS: mapFor(slug) });

      await expect(fetchVideo(slug)).rejects.toThrow("Not a directory");
    } finally {
      await Deno.remove(guideDir(slug));
    }
  });
});
