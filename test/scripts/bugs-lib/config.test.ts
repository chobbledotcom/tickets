import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { bugsConfig, parseIssueRef } from "#scripts/bugs-lib.ts";
import { BASE, ISSUE_ID } from "./support.ts";

describe("parseIssueRef", () => {
  test("extracts the issue id from an issue page URL", () => {
    expect(
      parseIssueRef(`https://bugs.chobble.com/issues/issue/${ISSUE_ID}/`),
    ).toBe(ISSUE_ID);
  });

  test("extracts the issue id from a markdown summary URL", () => {
    expect(parseIssueRef(`${BASE}/issues/issue/${ISSUE_ID}/md/`)).toBe(
      ISSUE_ID,
    );
  });

  test("passes a bare issue id through", () => {
    expect(parseIssueRef(ISSUE_ID)).toBe(ISSUE_ID);
  });

  test("passes a friendly issue id through", () => {
    expect(parseIssueRef("TIC-1")).toBe("TIC-1");
  });

  test("refuses a URL that holds no issue id", () => {
    expect(() => parseIssueRef(`${BASE}/projects/`)).toThrow(
      "No issue id found",
    );
  });
});

describe("bugsConfig", () => {
  const env = (values: Record<string, string>) => (key: string) => values[key];

  test("reads SENTRY_BASE_URL and strips the trailing slash", () => {
    expect(
      bugsConfig(env({ SENTRY_API_KEY: "k", SENTRY_BASE_URL: `${BASE}/` })),
    ).toEqual({ apiKey: "k", baseUrl: BASE });
  });

  test("falls back to SENTRY_BASE", () => {
    expect(bugsConfig(env({ SENTRY_API_KEY: "k", SENTRY_BASE: BASE }))).toEqual(
      { apiKey: "k", baseUrl: BASE },
    );
  });

  test("an empty SENTRY_BASE_URL falls through to SENTRY_BASE", () => {
    expect(
      bugsConfig(
        env({
          SENTRY_API_KEY: "k",
          SENTRY_BASE: BASE,
          SENTRY_BASE_URL: "",
        }),
      ),
    ).toEqual({ apiKey: "k", baseUrl: BASE });
  });

  test("accepts an http base URL for a local instance", () => {
    expect(
      bugsConfig(
        env({ SENTRY_API_KEY: "k", SENTRY_BASE_URL: "http://bugs.local" }),
      ),
    ).toEqual({ apiKey: "k", baseUrl: "http://bugs.local" });
  });

  test("refuses to run without a base URL", () => {
    expect(() => bugsConfig(env({ SENTRY_API_KEY: "k" }))).toThrow(
      "Set SENTRY_BASE_URL",
    );
  });

  test("refuses to run without an API key", () => {
    expect(() => bugsConfig(env({ SENTRY_BASE_URL: BASE }))).toThrow(
      "Set SENTRY_API_KEY",
    );
  });

  test("refuses a base URL that is not a URL", () => {
    expect(() =>
      bugsConfig(env({ SENTRY_API_KEY: "k", SENTRY_BASE_URL: "bugs" })),
    ).toThrow("is not a URL");
  });

  test("refuses a base URL that is not http or https", () => {
    expect(() =>
      bugsConfig(
        env({
          SENTRY_API_KEY: "k",
          SENTRY_BASE_URL: "ftp://bugs.example.com",
        }),
      ),
    ).toThrow("must be an http or https URL");
  });
});
