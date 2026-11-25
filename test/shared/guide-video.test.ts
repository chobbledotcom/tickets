import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  guideVideoUrl,
  parseGuideCdnBase,
  resolveGuideCdnBase,
} from "#shared/guide-video.ts";

describe("guideVideoUrl", () => {
  test("builds the guide page under a published release base", () => {
    expect(
      guideVideoUrl(
        "https://assets.example.com/static/guides/abc123",
        "create-a-listing",
      ),
    ).toBe(
      "https://assets.example.com/static/guides/abc123/create-a-listing/index.html",
    );
  });

  test("drops a trailing slash from the base", () => {
    expect(
      guideVideoUrl("https://cdn.example.com/guides/abc/", "listing"),
    ).toBe("https://cdn.example.com/guides/abc/listing/index.html");
  });

  test("has no address when the build published no guide", () => {
    expect(guideVideoUrl(null, "create-a-listing")).toBeNull();
    expect(guideVideoUrl("", "create-a-listing")).toBeNull();
  });
});

describe("parseGuideCdnBase", () => {
  test("keeps an absolute local preview base", () => {
    expect(parseGuideCdnBase("http://127.0.0.1:8081")).toBe(
      "http://127.0.0.1:8081",
    );
  });

  test("treats an absent or empty base as no guide", () => {
    expect(parseGuideCdnBase(undefined)).toBeNull();
    expect(parseGuideCdnBase("")).toBeNull();
  });
});

describe("resolveGuideCdnBase", () => {
  test("keeps the baked base ahead of a local preview", () => {
    expect(
      resolveGuideCdnBase("https://cdn.example.com/guides/abc", "http://local"),
    ).toBe("https://cdn.example.com/guides/abc");
  });

  test("uses the local preview when no base was baked", () => {
    expect(resolveGuideCdnBase(null, "http://local")).toBe("http://local");
    expect(resolveGuideCdnBase(null, undefined)).toBeNull();
  });
});
