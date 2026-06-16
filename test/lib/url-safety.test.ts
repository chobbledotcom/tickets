import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { isSafeWebhookUrl } from "#shared/url-safety.ts";

describe("url-safety", () => {
  describe("isSafeWebhookUrl accepts public https URLs", () => {
    const safe = [
      "https://example.com/webhook",
      "https://hooks.example.org/path?x=1",
      "https://8.8.8.8/hook",
      "https://1.1.1.1/",
      "https://172.15.0.1/", // just below the private 172.16-31 range
      "https://172.32.0.1/", // just above it
      "https://100.63.0.1/", // just below CGNAT
      "https://100.128.0.1/", // just above CGNAT
      "https://[2001:db8::1]/", // public IPv6
    ];
    for (const url of safe) {
      test(url, () => expect(isSafeWebhookUrl(url)).toBe(true));
    }
  });

  describe("isSafeWebhookUrl rejects unsafe URLs", () => {
    const unsafe = [
      "http://example.com/webhook", // not https
      "ftp://example.com/", // not https
      "not a url", // unparseable
      "https://localhost/hook",
      "https://api.localhost/hook",
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
      "https://[::1]/", // IPv6 loopback
      "https://[fe80::1]/", // IPv6 link-local
      "https://[fc00::1]/", // IPv6 unique-local
      "https://[fd12::1]/", // IPv6 unique-local
    ];
    for (const url of unsafe) {
      test(url, () => expect(isSafeWebhookUrl(url)).toBe(false));
    }
  });
});
