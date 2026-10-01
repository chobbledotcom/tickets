import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  getBaseUrl,
  getSearchParam,
  parseCookies,
  parseRequest,
} from "#routes/url.ts";

test("parses request cookies", () => {
  const request = new Request("https://example.test", {
    headers: { cookie: "first=one; second=two" },
  });
  expect(parseCookies(request)).toEqual(
    new Map([
      ["first", "one"],
      ["second", "two"],
    ]),
  );
});

test("extracts the origin from a request", () => {
  expect(getBaseUrl(new Request("https://example.test:8443/path"))).toBe(
    "https://example.test:8443",
  );
});

test("parses method, URL, and a normalized path", () => {
  const request = new Request("https://example.test/scheduled///?page=2", {
    method: "POST",
  });
  const parsed = parseRequest(request);
  expect(parsed.method).toBe("POST");
  expect(parsed.path).toBe("/scheduled");
  expect(parsed.url.searchParams.get("page")).toBe("2");
});

test("returns a query value or an empty string", () => {
  const request = new Request("https://example.test/?present=value&empty=");
  expect(getSearchParam(request, "present")).toBe("value");
  expect(getSearchParam(request, "empty")).toBe("");
  expect(getSearchParam(request, "missing")).toBe("");
});
