// Property tests for the SSRF guard: isSafeServerFetchUrl is total on
// arbitrary input, accepts every https URL on a public-looking dot domain,
// and rejects the documented classes (wrong scheme, IP literals, internal
// names). fast-check runs each property with a fixed seed and run count, so
// every run generates the same cases.
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as fc from "fast-check";
import { isSafeServerFetchUrl } from "#shared/url-safety.ts";

const seedArgs = { numRuns: 100, seed: 20261018 } as const;

/** A generator of public-looking dot-separated domains: every label starts
 * and ends with a letter, so no generated host can read as an IP literal or
 * an internal name. */
const publicDomain = fc.stringMatching(
  /^[a-z][a-z0-9-]{0,10}(\.[a-z][a-z0-9-]{0,10}){1,3}\.example$/,
);

/** The reject classes the module documents. */
const UNSAFE_URLS = [
  "http://shop.example.com",
  "https://localhost",
  "https://foo.localhost",
  "https://bar.local",
  "https://baz.internal",
  "https://10.0.0.1",
  "https://[::1]",
  "not a url",
  "",
] as const;

describe("isSafeServerFetchUrl properties", () => {
  test("is total on arbitrary input", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (raw) => {
        expect(typeof isSafeServerFetchUrl(raw)).toBe("boolean");
      }),
      seedArgs,
    );
  });

  test("accepts every https URL on a public dot domain", () => {
    // The path generator stays inside the URL-safe character set: a raw `%`
    // or a control character would make the URL unparseable, and the
    // documented reject for syntactically invalid URLs is covered by the
    // reject class below. This property is about host classification.
    fc.assert(
      fc.property(
        publicDomain,
        fc.stringMatching(/^\/[A-Za-z0-9._~-]{0,20}$/),
        (host, path) => {
          expect(isSafeServerFetchUrl(`https://${host}${path}`)).toBe(true);
        },
      ),
      seedArgs,
    );
  });

  test("rejects the documented unsafe classes", () => {
    // Sampling a fixed list can miss an entry, so every documented reject
    // class is asserted on its own line.
    for (const raw of UNSAFE_URLS) {
      expect(isSafeServerFetchUrl(raw)).toBe(false);
    }
  });

  test("never accepts a non-https scheme", () => {
    fc.assert(
      fc.property(
        publicDomain,
        fc.constantFrom("http:", "ftp:", "file:", "javascript:"),
        (host, scheme) => {
          expect(isSafeServerFetchUrl(`${scheme}//${host}/`)).toBe(false);
        },
      ),
      seedArgs,
    );
  });
});
