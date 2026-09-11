import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { siteBaseUrl, toStableHostname } from "#shared/site-address.ts";

describe("toStableHostname", () => {
  test("maps a bunny.run hostname to b-cdn.net", () => {
    expect(toStableHostname("child.newsite.bunny.run")).toBe(
      "child.newsite.b-cdn.net",
    );
  });

  test("leaves a b-cdn.net hostname as it is", () => {
    expect(toStableHostname("child.b-cdn.net")).toBe("child.b-cdn.net");
  });

  test("leaves a Deno Deploy hostname as it is", () => {
    expect(toStableHostname("site.org.deno.net")).toBe("site.org.deno.net");
  });

  test("leaves a custom domain as it is", () => {
    expect(toStableHostname("tickets.example.co.uk")).toBe(
      "tickets.example.co.uk",
    );
  });
});

describe("siteBaseUrl", () => {
  test("prepends https:// to a bare hostname", () => {
    expect(siteBaseUrl("site.b-cdn.net")).toBe("https://site.b-cdn.net");
  });

  test("keeps an existing scheme", () => {
    expect(siteBaseUrl("http://example.com")).toBe("http://example.com");
  });

  test("strips a trailing slash so a path can be appended", () => {
    expect(siteBaseUrl("https://example.com/")).toBe("https://example.com");
  });

  test("collapses a path, query, and hash to the origin", () => {
    expect(siteBaseUrl("https://example.com/admin?x=1#y")).toBe(
      "https://example.com",
    );
  });

  test("normalizes an uppercase scheme to a lowercase origin", () => {
    expect(siteBaseUrl("HTTPS://example.com")).toBe("https://example.com");
  });

  test("gives a bunny.run site its stable b-cdn.net address", () => {
    expect(siteBaseUrl("child.newsite.bunny.run")).toBe(
      "https://child.newsite.b-cdn.net",
    );
  });

  test("maps the bunny.run host when the URL also carries a scheme and path", () => {
    expect(siteBaseUrl("https://child.bunny.run/admin?x=1")).toBe(
      "https://child.b-cdn.net",
    );
  });

  test("maps the bunny.run host when the URL also carries a port", () => {
    expect(siteBaseUrl("https://child.bunny.run:8443")).toBe(
      "https://child.b-cdn.net:8443",
    );
  });

  test("keeps a custom domain's non-default port", () => {
    expect(siteBaseUrl("https://tickets.example.co.uk:8443")).toBe(
      "https://tickets.example.co.uk:8443",
    );
  });

  test("leaves a Deno Deploy URL on its own address", () => {
    expect(siteBaseUrl("https://site.org.deno.net/")).toBe(
      "https://site.org.deno.net",
    );
  });

  test("leaves a custom domain on its own address", () => {
    expect(siteBaseUrl("tickets.example.co.uk")).toBe(
      "https://tickets.example.co.uk",
    );
  });
});
