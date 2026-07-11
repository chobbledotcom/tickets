import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  createTokenRoute,
  extractTokenSegment,
  parseTokens,
  WALLET_CACHE_CONTROL,
} from "#routes/tickets/token-utils.ts";

describe("parseTokens", () => {
  test("splits on +, drops empty segments, and de-duplicates", () => {
    expect(parseTokens("a+b+a")).toEqual(["a", "b"]);
    expect(parseTokens("a++b+")).toEqual(["a", "b"]);
  });

  test("treats a separator-free string as a single token", () => {
    // A "+"→"" mutant would split every character apart.
    expect(parseTokens("abc")).toEqual(["abc"]);
  });

  test("keeps one-character tokens", () => {
    // A length>0 → length>1 mutant would drop "a".
    expect(parseTokens("a+bb")).toEqual(["a", "bb"]);
  });

  test("returns an empty array for an empty string", () => {
    expect(parseTokens("")).toEqual([]);
  });
});

describe("extractTokenSegment", () => {
  test("returns the token segment after the prefix", () => {
    // match[1] is the captured segment; match[0] would be the whole path.
    expect(extractTokenSegment("t", "/t/abc")).toBe("abc");
  });

  test("keeps + separators inside the segment", () => {
    expect(extractTokenSegment("t", "/t/a+b+c")).toBe("a+b+c");
  });

  test("works for any prefix", () => {
    expect(extractTokenSegment("checkin", "/checkin/xyz")).toBe("xyz");
  });

  test("returns null when the prefix does not match", () => {
    expect(extractTokenSegment("t", "/other/abc")).toBeNull();
  });

  test("returns null when there is no segment after the prefix", () => {
    expect(extractTokenSegment("t", "/t/")).toBeNull();
  });

  test("does not treat an empty match as no match (prefix is unescaped)", () => {
    // Production callers pass literal prefixes ("t"/"checkin"/…), but the
    // prefix is interpolated into the pattern unescaped, so a grouping prefix
    // makes match[1] the — here empty — prefix capture. This pins the `?? null`
    // contract (keep the "" result) against `|| null` (which would drop it),
    // and documents that the helper does not sanitise its prefix.
    expect(extractTokenSegment("(a*)", "//abc")).toBe("");
  });
});

describe("createTokenRoute", () => {
  const request = new Request("http://localhost/t/abc");
  const route = createTokenRoute("t", {
    GET: () => new Response("ok"),
  });

  test("returns null when the path has no token segment for the prefix", async () => {
    expect(await route(request, "/other/abc", "GET", undefined)).toBeNull();
  });

  test("returns null when no handler is registered for the method", async () => {
    expect(await route(request, "/t/abc", "POST", undefined)).toBeNull();
  });
});

test("WALLET_CACHE_CONTROL caches for 5 min in browser, 1 hour on CDN", () => {
  expect(WALLET_CACHE_CONTROL).toBe("public, max-age=300, s-maxage=3600");
});
