import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { isSafeServerFetchUrl } from "#shared/url-safety.ts";

describe("url-safety", () => {
  describe("isSafeServerFetchUrl accepts public https domains", () => {
    const safe = [
      "https://example.com/webhook",
      "https://hooks.example.org/path?x=1",
      "https://sub.domain.example.co.uk/",
      "https://app.example.net/path?x=1",
    ];
    for (const url of safe) {
      test(url, () => expect(isSafeServerFetchUrl(url)).toBe(true));
    }
  });

  describe("isSafeServerFetchUrl rejects unsafe URLs", () => {
    const unsafe = [
      "http://example.com/webhook", // not https
      "ftp://example.com/", // not https
      "not a url", // unparseable
      "https://example", // not a proper domain
      "https://localhost/hook",
      "https://example.com@localhost/hook",
      "https://example.com%2f@localhost/hook",
      "https://api.localhost/hook",
      "https://example.local/hook",
      "https://service.internal/hook",
      "https://metadata.google.internal/",
      "https://0.0.0.0/",
      "https://10.0.0.5/",
      "https://127.0.0.1/hook",
      "https://169.254.169.254/latest/meta-data", // cloud metadata
      "https://192.168.1.10/",
      "https://172.16.0.1/",
      "https://172.31.255.254/",
      "https://100.64.0.1/", // CGNAT
      "https://8.8.8.8/hook",
      "https://[2001:db8::1]/", // IPv6 literal
      "https://2001:db8::1/", // bare IPv6-like host fails as an IP literal before domain checks
      "https://[::1]/", // IPv6 loopback
      "https://[fe80::1]/", // IPv6 link-local
      "https://[fc00::1]/", // IPv6 unique-local
      "https://[fd12::1]/", // IPv6 unique-local
    ];
    for (const url of unsafe) {
      test(url, () => expect(isSafeServerFetchUrl(url)).toBe(false));
    }
  });

  test("keeps host safety decisions stable when paths, credentials, and ports change", () => {
    const variants = [
      ["https://example.com", true],
      ["https://user:pass@example.com:8443/path?next=http://localhost", true],
      ["https://127.0.0.1", false],
      ["https://user:pass@127.0.0.1:8443/path?next=https://example.com", false],
      ["https://service.internal", false],
      ["https://user:pass@service.internal:8443/path", false],
    ] as const;

    for (const [url, expected] of variants) {
      expect(isSafeServerFetchUrl(url)).toBe(expected);
    }
  });
});
