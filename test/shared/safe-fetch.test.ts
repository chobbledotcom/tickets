import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { FetchResult } from "#shared/fetch.ts";
import { fetchTextFollowingSafeRedirects } from "#shared/safe-fetch.ts";

const response = (status: number, location?: string): FetchResult => ({
  headers: new Headers(location ? { location } : undefined),
  ok: status >= 200 && status < 300,
  status,
  text: "body",
});

describe("safe-fetch", () => {
  test("returns a redirect response unchanged when location is missing", async () => {
    const result = await fetchTextFollowingSafeRedirects(
      "https://example.com/start",
      undefined,
      () => Promise.resolve(response(302)),
    );

    expect(result.status).toBe(302);
  });

  // Every status the standard uses to say "go and ask over there". Written out
  // rather than read from the source, so dropping one from the list has to be
  // a deliberate edit here too.
  for (const status of [301, 302, 303, 307, 308]) {
    test(`follows a ${status} to its destination`, async () => {
      const asked: string[] = [];
      const result = await fetchTextFollowingSafeRedirects(
        "https://example.com/start",
        undefined,
        (url) => {
          asked.push(url);
          return Promise.resolve(
            asked.length === 1
              ? response(status, "https://example.com/moved")
              : response(200),
          );
        },
      );

      expect(asked).toEqual([
        "https://example.com/start",
        "https://example.com/moved",
      ]);
      expect(result.status).toBe(200);
    });
  }

  test("leaves a status that is not a redirect alone", async () => {
    const asked: string[] = [];
    const result = await fetchTextFollowingSafeRedirects(
      "https://example.com/start",
      undefined,
      (url) => {
        asked.push(url);
        return Promise.resolve(response(304, "https://example.com/moved"));
      },
    );

    expect(asked).toEqual(["https://example.com/start"]);
    expect(result.status).toBe(304);
  });

  test("rejects syntactically invalid redirect locations", async () => {
    await expect(
      fetchTextFollowingSafeRedirects(
        "https://example.com/start",
        undefined,
        () => Promise.resolve(response(302, "http://[::1")),
      ),
    ).rejects.toThrow("Unsafe redirect URL");
  });

  test("rejects unsafe redirect targets before fetching them", async () => {
    const seen: string[] = [];

    await expect(
      fetchTextFollowingSafeRedirects(
        "https://example.com/start",
        undefined,
        (url) => {
          seen.push(url);
          return Promise.resolve(response(302, "http://internal.local/hook"));
        },
      ),
    ).rejects.toThrow("Unsafe redirect URL");

    expect(seen).toEqual(["https://example.com/start"]);
  });

  test("stops after the maximum safe redirect hops", async () => {
    const seen: string[] = [];

    await expect(
      fetchTextFollowingSafeRedirects(
        "https://example.com/start",
        undefined,
        (url) => {
          seen.push(url);
          return Promise.resolve(response(302, "/next"));
        },
      ),
    ).rejects.toThrow("Too many redirects");

    // The original URL plus the five allowed hops, and not one fetch more.
    expect(seen.length).toBe(6);
  });

  test("follows a chain that uses every allowed hop", async () => {
    const seen: string[] = [];

    const result = await fetchTextFollowingSafeRedirects(
      "https://example.com/0",
      undefined,
      (url) => {
        seen.push(url);
        // Five redirects, then a real page on the sixth fetch.
        return Promise.resolve(
          seen.length <= 5 ? response(302, `/${seen.length}`) : response(200),
        );
      },
    );

    expect(result.status).toBe(200);
    expect(seen.length).toBe(6);
  });
});
