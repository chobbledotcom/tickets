import { assertThrows } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type PublishedGuideVideos,
  type PublishVideosOptions,
  publishVideos,
} from "#scripts/guides/publish-videos.ts";
import { parseGuideStoryboard } from "#scripts/guides/storyboard.ts";
import {
  GUIDE_SLUGS,
  guideStoryboard,
} from "#scripts/guides/storyboards/index.ts";
import {
  guideVideoInputsHash,
  guideVideoObjectPath,
  guideVideoPointerPath,
  parseGuideVideoPointer,
} from "#scripts/guides/video.ts";
import { publicUrlFor } from "#scripts/static-cdn.ts";
import { sha256Hex } from "#shared/sha256.ts";
import { CONFIG } from "#test/scripts/static-cdn-fixtures.ts";

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
    if (stored === undefined) return new Response("missing", { status: 404 });
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

/** The pointer address that a publish run asks about first. */
const pointerUrl = async (): Promise<string> =>
  publicUrlFor(
    CONFIG,
    guideVideoPointerPath(SLUG, await inputsHashFor(ANCHORS)),
  );

/** The fake CDN, with one address answered by `reply` instead. */
const cdnWith = (
  reply: (request: Request) => Response | undefined,
): typeof fetch => {
  const { fetcher } = fakeCdn();
  return async (input, init) => {
    const request = new Request(input, init);
    return reply(request) ?? (await fetcher(request));
  };
};

/** Answer the first request to `address` with `reply`, then use the fake CDN.
 * A publish run asks the pointer address again when it verifies the upload. */
const answerPointerOnce = (
  address: string,
  reply: () => Response,
): ((request: Request) => Response | undefined) => {
  let answered = false;
  return (request) => {
    if (answered || request.url !== address) return;
    answered = true;
    return reply();
  };
};

/** Publish the fixture guide through a fake CDN, overriding one choice. */
const publishWith = (
  fetcher: typeof fetch,
  overrides: Partial<Pick<PublishVideosOptions, "anchors" | "render">> = {},
) =>
  publishVideos(CONFIG, {
    anchors: ANCHORS,
    fetcher,
    render: () => Promise.resolve(MP4),
    slug: SLUG,
    ...overrides,
  });

/** The URL a publish of these bytes gives the guide. */
const renderedVideoUrl = async (bytes = MP4): Promise<string> =>
  `${CONFIG.cdnUrl}/${guideVideoObjectPath(SLUG, await sha256Hex(bytes))}`;

/** Assert that the run uploaded the fixture MP4. */
const expectRendered = async (
  published: PublishedGuideVideos,
): Promise<void> => {
  expect(published.videos[SLUG]?.video).toBe(await renderedVideoUrl());
};

/** A pointer object for these inputs and this video path. */
const pointerFor = (inputs: string, video: string): Response =>
  new Response(JSON.stringify({ inputs, schemaVersion: 1, video }));

/** Publish through a fake CDN whose pointer read answers `pointer`, and whose
 * HEAD read answers `head` when one is given. */
const expectRenderAfterPointer = async (
  pointer: Response,
  head?: Response,
): Promise<void> => {
  const address = await pointerUrl();
  const answered = answerPointerOnce(address, () => pointer);
  const fetcher = cdnWith((request) => {
    const reply = answered(request);
    if (reply !== undefined) return reply;
    return request.method === "HEAD" ? head : undefined;
  });
  await expectRendered(await publishWith(fetcher));
};

describe("publishVideos", () => {
  test("uploads the MP4 under its content hash beside an inputs pointer", async () => {
    const { fetcher, objects } = fakeCdn();
    const rendered: string[] = [];
    const render = (slug: string): Promise<Uint8Array> => {
      rendered.push(slug);
      return Promise.resolve(MP4);
    };

    const published = await publishWith(fetcher, { render });

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
    const first = await publishWith(fetcher);

    const second = await publishWith(fetcher, {
      render: () => Promise.reject(new Error("must not render")),
    });

    expect(second.videos).toEqual(first.videos);
  });

  test("renders again when an anchored screenshot changes", async () => {
    const { fetcher } = fakeCdn();
    const before = await publishWith(fetcher);
    const changed = new TextEncoder().encode("different-footage");
    const after = await publishWith(fetcher, {
      anchors: OTHER_ANCHORS,
      render: () => Promise.resolve(changed),
    });

    expect(after.videos[SLUG]?.video).toBe(await renderedVideoUrl(changed));
    expect(after.videos[SLUG]?.video).not.toBe(before.videos[SLUG]?.video);
  });

  test("renders again when the pointer is unusable", () =>
    expectRenderAfterPointer(new Response("not a pointer")));

  test("renders again when the pointer names other inputs", () =>
    expectRenderAfterPointer(
      pointerFor("0".repeat(16), "guides/other-0123456789abcdef.mp4"),
    ));

  test("renders again when the pointer's video is gone", async () =>
    expectRenderAfterPointer(
      pointerFor(
        await inputsHashFor(ANCHORS),
        "guides/missing-0123456789abcdef.mp4",
      ),
      new Response("gone", { status: 404 }),
    ));

  test("publishes every guide when no slug is named", async () => {
    const { fetcher } = fakeCdn();

    const published = await publishVideos(CONFIG, {
      anchors: ANCHORS,
      fetcher,
      render: () => Promise.resolve(MP4),
    });

    expect(published.slugs).toEqual(GUIDE_SLUGS);
    await expectRendered(published);
  });

  test("refuses a guide with no anchors instead of rendering blind", async () => {
    const { fetcher } = fakeCdn();
    await expect(publishWith(fetcher, { anchors: {} })).rejects.toThrow(
      "specs:evidence",
    );
  });
});

describe("guideStoryboard", () => {
  test("refuses a slug that names no guide", () => {
    assertThrows(
      () => guideStoryboard("unknown-guide"),
      Error,
      "Unknown guide unknown-guide",
    );
  });
});
