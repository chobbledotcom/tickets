import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { publishGuideVideos } from "#scripts/guides/publish.ts";
import { parseGuideStoryboard } from "#scripts/guides/storyboard.ts";
import { guideStoryboard } from "#scripts/guides/storyboards/index.ts";
import {
  guideVideoInputsHash,
  guideVideoObjectPath,
  guideVideoPointerPath,
  parseGuideVideoPointer,
} from "#scripts/guides/video.ts";
import { sha256Hex } from "#shared/sha256.ts";
import { CONFIG } from "../static-cdn-fixtures.ts";

const SLUG = "create-a-listing";
const MP4 = new TextEncoder().encode("fake-mp4-bytes");
const ANCHORS = {
  [SLUG]: { "capture-one": "a".repeat(60), "capture-two": "b".repeat(60) },
};
const OTHER_ANCHORS = {
  [SLUG]: { "capture-one": "c".repeat(60), "capture-two": "b".repeat(60) },
};

interface Stored {
  bytes: Uint8Array;
  contentType: string;
}

/** A fake Bunny zone: PUTs land in the map, the pull zone serves them back,
 * and the purge endpoint always succeeds. */
const fakeCdn = () => {
  const objects = new Map<string, Stored>();
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.host === "storage.bunnycdn.com" && request.method === "PUT") {
      objects.set(url.pathname.replace("/tickets-assets/static/", ""), {
        bytes: new Uint8Array(await request.arrayBuffer()),
        contentType: request.headers.get("content-type") ?? "",
      });
      return new Response(null, { status: 201 });
    }
    if (url.host === "api.bunny.net")
      return new Response(null, { status: 204 });
    if (url.host !== "assets.example.com") {
      throw new Error(`Unexpected host in ${request.method} ${url.href}`);
    }
    const stored = objects.get(url.pathname.replace("/static/", ""));
    if (stored === undefined) return new Response(null, { status: 404 });
    if (request.method === "HEAD") {
      return new Response(null, {
        headers: { "content-type": stored.contentType },
        status: 200,
      });
    }
    return new Response(Uint8Array.from(stored.bytes).buffer, {
      headers: { "content-type": stored.contentType },
    });
  };
  return { fetcher, objects };
};

const inputsHashFor = async (
  anchors: Readonly<Record<string, Readonly<Record<string, string>>>>,
): Promise<string> =>
  guideVideoInputsHash({
    anchors: anchors[SLUG]!,
    slug: SLUG,
    storyboard: JSON.stringify(parseGuideStoryboard(guideStoryboard(SLUG))),
  });

describe("publishGuideVideos", () => {
  test("uploads the MP4 under its content hash beside an inputs pointer", async () => {
    const { fetcher, objects } = fakeCdn();
    const rendered: string[] = [];
    const render = (slug: string): Promise<Uint8Array> => {
      rendered.push(slug);
      return Promise.resolve(MP4);
    };

    const published = await publishGuideVideos(CONFIG, {
      anchors: ANCHORS,
      fetcher,
      render,
      slug: SLUG,
    });

    const videoPath = guideVideoObjectPath(SLUG, await sha256Hex(MP4));
    const pointerPath = guideVideoPointerPath(
      SLUG,
      await inputsHashFor(ANCHORS),
    );
    expect(rendered).toEqual([SLUG]);
    expect(published.slugs).toEqual([SLUG]);
    expect(published.videos).toEqual({
      [SLUG]: { video: `${CONFIG.cdnUrl}/${videoPath}` },
    });
    expect([...objects.keys()].sort()).toEqual([pointerPath, videoPath].sort());
    expect(objects.get(videoPath)?.contentType).toBe("video/mp4");

    const pointer = parseGuideVideoPointer(
      JSON.parse(new TextDecoder().decode(objects.get(pointerPath)?.bytes)),
    );
    expect(pointer).toEqual({
      inputs: await inputsHashFor(ANCHORS),
      schemaVersion: 1,
      video: videoPath,
    });
  });

  test("reuses the uploaded video when the inputs still match", async () => {
    const { fetcher } = fakeCdn();
    const first = await publishGuideVideos(CONFIG, {
      anchors: ANCHORS,
      fetcher,
      render: () => Promise.resolve(MP4),
      slug: SLUG,
    });

    const second = await publishGuideVideos(CONFIG, {
      anchors: ANCHORS,
      fetcher,
      render: () => Promise.reject(new Error("must not render")),
      slug: SLUG,
    });

    expect(second.videos).toEqual(first.videos);
  });

  test("renders again when an anchored screenshot changes", async () => {
    const { fetcher } = fakeCdn();
    const before = await publishGuideVideos(CONFIG, {
      anchors: ANCHORS,
      fetcher,
      render: () => Promise.resolve(MP4),
      slug: SLUG,
    });
    const changed = new TextEncoder().encode("different-footage");
    const after = await publishGuideVideos(CONFIG, {
      anchors: OTHER_ANCHORS,
      fetcher,
      render: () => Promise.resolve(changed),
      slug: SLUG,
    });

    expect(after.videos[SLUG]?.video).toBe(
      `${CONFIG.cdnUrl}/${guideVideoObjectPath(SLUG, await sha256Hex(changed))}`,
    );
    expect(after.videos[SLUG]?.video).not.toBe(before.videos[SLUG]?.video);
  });

  test("refuses a guide with no anchors instead of rendering blind", async () => {
    const { fetcher } = fakeCdn();
    await expect(
      publishGuideVideos(CONFIG, {
        anchors: {},
        fetcher,
        render: () => Promise.resolve(MP4),
        slug: SLUG,
      }),
    ).rejects.toThrow("specs:evidence");
  });
});
