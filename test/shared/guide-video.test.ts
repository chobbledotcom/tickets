import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  guideVideoUrl,
  parseGuideCdnBase,
  resolveGuideCdnBase,
} from "#shared/guide-video.ts";

describe("guideVideoUrl", () => {
  test("builds the guide page from every accepted base", () => {
    const cases = [
      [
        "https://assets.example.com/static/guides/abc123",
        "create-a-listing",
        "https://assets.example.com/static/guides/abc123/create-a-listing/index.html",
      ],
      [
        "https://cdn.example.com/guides/abc/",
        "listing",
        "https://cdn.example.com/guides/abc/listing/index.html",
      ],
      [null, "create-a-listing", null],
      ["", "create-a-listing", null],
    ] as const;
    for (const [base, slug, expected] of cases) {
      expect(guideVideoUrl(base, slug)).toBe(expected);
    }
  });
});

describe("parseGuideCdnBase", () => {
  test("reads a local preview base and treats an empty one as absent", () => {
    const cases = [
      ["http://127.0.0.1:8081", "http://127.0.0.1:8081"],
      [undefined, null],
      ["", null],
    ] as const;
    for (const [base, expected] of cases) {
      expect(parseGuideCdnBase(base)).toBe(expected);
    }
  });
});

describe("resolveGuideCdnBase", () => {
  test("prefers the baked base and falls back to the local preview", () => {
    const cases = [
      [
        "https://cdn.example.com/guides/abc",
        "http://local",
        "https://cdn.example.com/guides/abc",
      ],
      [null, "http://local", "http://local"],
      [null, undefined, null],
    ] as const;
    for (const [baked, env, expected] of cases) {
      expect(resolveGuideCdnBase(baked, env)).toBe(expected);
    }
  });
});
