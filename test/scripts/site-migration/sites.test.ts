import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { fetchSites } from "#scripts/site-migration/sites.ts";

const instance = { key: "main-key", url: "https://main.example.com/" };
const signal = new AbortController().signal;

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200 });

describe("site credentials", () => {
  test("asks the main site and names each database host", async () => {
    const calls: [string, RequestInit | undefined][] = [];
    const sites = await fetchSites(
      instance,
      (url, init) => {
        calls.push([String(url), init]);
        return Promise.resolve(
          jsonResponse({
            sites: [
              {
                dbToken: "token-a",
                dbUrl: "libsql://abc-one.lite.bunnydb.net",
                name: "one",
                scriptId: "1",
              },
              {
                dbToken: "token-b",
                dbUrl: "libsql://two-org.turso.io",
                name: "two",
                scriptId: "2",
              },
            ],
          }),
        );
      },
      signal,
    );

    expect(calls[0]?.[0]).toBe(
      "https://main.example.com/instance/site-credentials",
    );
    expect(calls[0]?.[1]?.method).toBe("POST");
    expect(calls[0]?.[1]?.headers).toEqual({
      Authorization: "Bearer main-key",
    });
    expect(calls[0]?.[1]?.signal).toBe(signal);
    expect(sites).toEqual([
      {
        dbToken: "token-a",
        dbUrl: "libsql://abc-one.lite.bunnydb.net",
        host: "bunny",
        name: "one",
        scriptId: "1",
      },
      {
        dbToken: "token-b",
        dbUrl: "libsql://two-org.turso.io",
        host: "turso",
        name: "two",
        scriptId: "2",
      },
    ]);
  });

  test("fails when the main site refuses the key", async () => {
    await expect(
      fetchSites(
        instance,
        () =>
          Promise.resolve(
            new Response("no", { status: 401, statusText: "Unauthorized" }),
          ),
        signal,
      ),
    ).rejects.toThrow("The main site refused the request: 401 Unauthorized");
  });

  test("fails when a site is missing its database address", async () => {
    await expect(
      fetchSites(
        instance,
        () => Promise.resolve(jsonResponse({ sites: [{ name: "one" }] })),
        signal,
      ),
    ).rejects.toThrow();
  });
});
