import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { isLocalHttpHost } from "#shared/local-host.ts";

describe("isLocalHttpHost", () => {
  for (const host of [
    "localhost",
    "localhost.",
    "kuma.localhost",
    "kuma.localhost.",
    "[::1]",
    "127.0.0.1",
    "10.0.1.2",
    "100.64.0.1",
    "100.127.1.2",
    "169.254.10.5",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.10",
    "[fd00::1]",
    "[fd7a:115c:a1e0::1]",
    "[fc00::1]",
    "[fe80::1]",
    "[feb0::1]",
  ]) {
    test(`accepts the local host ${host}`, () => {
      expect(isLocalHttpHost(host)).toBe(true);
    });
  }

  for (const host of [
    "kuma.example.test",
    "bugs.local",
    // An unbracketed IPv6 name never comes from a URL parser, and the helper
    // must not read colon groups out of one.
    "fd00::1",
    "xfc00::1",
    "0.0.0.0",
    "8.8.8.8",
    "9.0.0.1",
    "11.0.0.1",
    "100.63.1.2",
    "100.128.1.2",
    "169.255.1.2",
    "172.15.0.1",
    "172.32.0.1",
    "192.169.0.1",
    "10.0.1.x",
    "10.0.0.1e0",
    "[::ffff:127.0.0.1]",
    "[2001:db8::1]",
    "[ff02::1]",
    "[fec0::1]",
    "[ff00::1]",
  ]) {
    test(`rejects the non-local host ${host}`, () => {
      expect(isLocalHttpHost(host)).toBe(false);
    });
  }
});
