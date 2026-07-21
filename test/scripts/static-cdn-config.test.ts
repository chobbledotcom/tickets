import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { loadStaticCdnConfig } from "#scripts/static-cdn.ts";
import { CONFIG, ENV } from "./static-cdn-fixtures.ts";

const REGIONAL_STORAGE_HOSTS = [
  "uk.storage.bunnycdn.com",
  "ny.storage.bunnycdn.com",
  "la.storage.bunnycdn.com",
  "sg.storage.bunnycdn.com",
  "se.storage.bunnycdn.com",
  "br.storage.bunnycdn.com",
  "jh.storage.bunnycdn.com",
  "syd.storage.bunnycdn.com",
] as const;

describe("loadStaticCdnConfig", () => {
  test("keeps builds self-contained when every CDN value is absent", () => {
    expect(loadStaticCdnConfig({})).toBeNull();
  });

  test("normalizes a complete CDN configuration", () => {
    expect(loadStaticCdnConfig(ENV)).toEqual(CONFIG);
  });

  test("normalizes repeated trailing slashes in the CDN base", () => {
    expect(
      loadStaticCdnConfig({
        ...ENV,
        CDN_URL: "https://assets.example.com/static///",
      }),
    ).toEqual(CONFIG);
  });

  for (const storageHost of REGIONAL_STORAGE_HOSTS) {
    test(`accepts the ${storageHost} Bunny storage host`, () => {
      expect(
        loadStaticCdnConfig({
          ...ENV,
          CDN_BUNNY_STORAGE_HOST: storageHost,
        }),
      ).toEqual({ ...CONFIG, storageHost });
    });
  }

  test("requires a storage host for a configured CDN", () => {
    expect(() =>
      loadStaticCdnConfig({ ...ENV, CDN_BUNNY_STORAGE_HOST: undefined }),
    ).toThrow("CDN_BUNNY_STORAGE_HOST");
  });

  test("rejects a blank storage host", () => {
    expect(() =>
      loadStaticCdnConfig({ ...ENV, CDN_BUNNY_STORAGE_HOST: " " }),
    ).toThrow("CDN_BUNNY_STORAGE_HOST");
  });

  test("rejects an unknown Bunny storage host", () => {
    expect(() =>
      loadStaticCdnConfig({
        ...ENV,
        CDN_BUNNY_STORAGE_HOST: "storage.example.com",
      }),
    ).toThrow(
      "CDN_BUNNY_STORAGE_HOST must be one of: storage.bunnycdn.com, uk.storage.bunnycdn.com, ny.storage.bunnycdn.com, la.storage.bunnycdn.com, sg.storage.bunnycdn.com, se.storage.bunnycdn.com, br.storage.bunnycdn.com, jh.storage.bunnycdn.com, syd.storage.bunnycdn.com",
    );
  });

  test("rejects a partial CDN configuration", () => {
    expect(() =>
      loadStaticCdnConfig({ CDN_URL: "https://assets.example.com" }),
    ).toThrow(
      "CDN_URL, CDN_BUNNY_STORAGE_ZONE_NAME, CDN_BUNNY_STORAGE_ZONE_KEY, CDN_BUNNY_STORAGE_HOST, CDN_BUNNY_PULL_ZONE_ID must all be set together",
    );
  });

  test("rejects a CDN URL that is not a clean HTTPS base", () => {
    expect(() =>
      loadStaticCdnConfig({
        ...ENV,
        CDN_URL: "http://assets.example.com/static",
      }),
    ).toThrow("HTTPS");
  });

  const expectUncleanUrlRejected = (cdnUrl: string): void => {
    expect(() =>
      loadStaticCdnConfig({
        ...ENV,
        CDN_URL: cdnUrl,
      }),
    ).toThrow("clean HTTPS base");
  };

  test("rejects credentials in an HTTPS base", () => {
    expectUncleanUrlRejected("https://user@assets.example.com/static");
  });

  test("rejects a query string in an HTTPS base", () => {
    expectUncleanUrlRejected("https://assets.example.com/static?mutable=true");
  });

  test("rejects a fragment in an HTTPS base", () => {
    expectUncleanUrlRejected("https://assets.example.com/static#asset");
  });

  test("rejects unsafe storage and pull-zone names", () => {
    expect(() =>
      loadStaticCdnConfig({
        ...ENV,
        CDN_BUNNY_PULL_ZONE_ID: "not-an-id",
        CDN_BUNNY_STORAGE_ZONE_NAME: "../assets",
      }),
    ).toThrow("storage zone");
  });

  test("rejects a non-numeric pull-zone id", () => {
    expect(() =>
      loadStaticCdnConfig({
        ...ENV,
        CDN_BUNNY_PULL_ZONE_ID: "not-an-id",
      }),
    ).toThrow("must be numeric");
  });

  test("requires the account key used to purge a configured CDN", () => {
    expect(() =>
      loadStaticCdnConfig({ ...ENV, BUNNY_ACCESS_KEY: undefined }),
    ).toThrow("BUNNY_ACCESS_KEY is required to purge the static CDN");
  });

  test("rejects a whitespace-only account key", () => {
    expect(() =>
      loadStaticCdnConfig({ ...ENV, BUNNY_ACCESS_KEY: "   " }),
    ).toThrow("BUNNY_ACCESS_KEY is required to purge the static CDN");
  });
});
