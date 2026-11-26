import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  guideVideoFor,
  guideVideoOrigins,
  parseGuideVideoAssetsJson,
  resolveGuideVideos,
} from "#shared/guide-video.ts";

const VIDEOS = {
  "create-a-listing": {
    video: "https://cdn.example.com/guides/create-a-listing-abc.mp4",
  },
};

describe("parseGuideVideoAssetsJson", () => {
  test("reads the workflow's map and treats a blank value as none", () => {
    expect(parseGuideVideoAssetsJson(JSON.stringify(VIDEOS))).toEqual(VIDEOS);
    expect(parseGuideVideoAssetsJson("{}")).toEqual({});
    expect(parseGuideVideoAssetsJson("  ")).toEqual({});
    expect(parseGuideVideoAssetsJson(undefined)).toEqual({});
  });

  test("accepts a site path for a local preview", () => {
    const local = { slug: { video: "/guide-videos/slug" } };
    expect(parseGuideVideoAssetsJson(JSON.stringify(local))).toEqual(local);
  });

  test("rejects an insecure, relative, or protocol-relative video address", () => {
    for (const video of [
      "http://cdn.example.com/x.mp4",
      "guide-videos/x",
      "//cdn.example.com/x.mp4",
    ]) {
      expect(() =>
        parseGuideVideoAssetsJson(JSON.stringify({ slug: { video } })),
      ).toThrow();
    }
  });
});

describe("resolveGuideVideos", () => {
  test("prefers the baked map and falls back to the environment", () => {
    expect(
      resolveGuideVideos(
        VIDEOS,
        JSON.stringify({ other: VIDEOS["create-a-listing"]! }),
      ),
    ).toEqual(VIDEOS);
    expect(resolveGuideVideos({}, JSON.stringify(VIDEOS))).toEqual(VIDEOS);
    expect(resolveGuideVideos({}, undefined)).toEqual({});
  });
});

describe("guideVideoFor", () => {
  test("names the video for a published guide and nothing for the rest", () => {
    expect(guideVideoFor(VIDEOS, "create-a-listing")).toEqual(
      VIDEOS["create-a-listing"],
    );
    expect(guideVideoFor(VIDEOS, "listing")).toBeNull();
  });
});

describe("guideVideoOrigins", () => {
  test("lists each distinct origin once and skips a site path", () => {
    expect(
      guideVideoOrigins({
        ...VIDEOS,
        listing: { video: "https://cdn.example.com/guides/listing-def.mp4" },
        local: { video: "/guide-videos/create-a-listing" },
        other: { video: "https://videos.example.com/other.mp4" },
      }),
    ).toEqual(["https://cdn.example.com", "https://videos.example.com"]);
    expect(guideVideoOrigins({})).toEqual([]);
  });
});
