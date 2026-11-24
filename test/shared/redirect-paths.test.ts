import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  checkRedirectFrom,
  checkRedirectTo,
  redirectKeyOfRequest,
  redirectKeyOfTarget,
  redirectsServe,
} from "#shared/redirect-paths.ts";

/** What a check answers for each raw address: its value, or its error. */
const answers = <Code extends string>(
  check: (raw: string) => unknown,
  rows: readonly (readonly [string, string])[],
  ok: boolean,
) =>
  expect(rows.map(([raw]) => check(raw))).toEqual(
    rows.map(([, said]) =>
      ok ? { ok, value: said } : { error: said as Code, ok },
    ),
  );

test("a from page keeps its key: lower case, with no trailing slash", () => {
  answers(
    checkRedirectFrom,
    [
      ["/old-page", "/old-page"],
      ["  /Old-Page/  ", "/old-page"],
      ["/ticket/Old-Slug", "/ticket/old-slug"],
      ["/", "/"],
      ["/a%20b", "/a%20b"],
      ["/administration", "/administration"],
    ],
    true,
  );
});

test("a from page is refused with the reason", () => {
  answers(
    checkRedirectFrom,
    [
      ["old-page", "not_a_path"],
      ["", "not_a_path"],
      ["https://example.com/old", "not_a_path"],
      ["/old?x=1", "has_query"],
      ["/old#top", "has_query"],
      ["//evil.example/path", "unsafe"],
      ["/a\\b", "unsafe"],
      ["/a/../b", "unsafe"],
      ["/a/%2e%2e/b", "unsafe"],
      ["/a%5Cb", "unsafe"],
      ["/a%zz", "unsafe"],
      ["/a\nb", "unsafe"],
      ["/admin", "reserved"],
      ["/admin/settings", "reserved"],
      ["/ADMIN/x", "reserved"],
      ["/api/admin/listings", "reserved"],
    ],
    false,
  );
});

test("a to page is kept as typed, trimmed", () => {
  const kept = [
    "/new-page",
    "/new-page?x=1#top",
    "/",
    "https://example.com/new",
    "http://example.com",
    "https://example.com/a?b=c#d",
  ];
  answers(
    checkRedirectTo,
    kept.map((raw) => [`  ${raw} `, raw] as const),
    true,
  );
});

test("a to page is refused with the reason", () => {
  answers(
    checkRedirectTo,
    [
      ["//evil.example", "unsafe"],
      ["/a/../b", "unsafe"],
      ["/a\\b", "unsafe"],
      ["/a\r\nSet-Cookie: x=1", "unsafe"],
      ["https://user:pass@example.com", "unsafe"],
      ["https://user@example.com", "unsafe"],
      ["javascript:alert(1)", "not_http"],
      ["data:text/html,hi", "not_http"],
      ["ftp://example.com", "not_http"],
      ["mailto:a@example.com", "not_http"],
      ["example.com/page", "not_http"],
      ["not a url", "not_http"],
    ],
    false,
  );
});

test("a request path and a saved address meet at one key", () => {
  expect(checkRedirectFrom("/Old-Page/")).toEqual({
    ok: true,
    value: "/old-page",
  });
  expect(["/OLD-page", "/old-page//", "/"].map(redirectKeyOfRequest)).toEqual([
    "/old-page",
    "/old-page",
    "/",
  ]);
});

test("a target names its page, or no page of this site", () => {
  expect(
    ["/New/?x=1#y", "/", "https://example.com/new"].map(redirectKeyOfTarget),
  ).toEqual(["/new", "/", null]);
});

test("the admin and the API never serve a redirect", () => {
  expect(
    ["/admin", "/Admin/users", "/api/x", "/ticket/x", "/administration"].map(
      redirectsServe,
    ),
  ).toEqual([false, false, false, true, true]);
});
