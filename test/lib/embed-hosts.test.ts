import { describe, expect, test } from "#test-compat";
import {
  buildFrameAncestors,
  parseEmbedHosts,
  validateEmbedHosts,
  validateHostPattern,
} from "#lib/embed-hosts.ts";

describe("embed-hosts", () => {
  describe("validateHostPattern", () => {
    test("accepts simple hostname", () => {
      expect(validateHostPattern("example.com")).toBeNull();
    });

    test("accepts subdomain hostname", () => {
      expect(validateHostPattern("sub.example.com")).toBeNull();
    });

    test("accepts wildcard subdomain", () => {
      expect(validateHostPattern("*.example.com")).toBeNull();
    });

    test("accepts deeply nested subdomain", () => {
      expect(validateHostPattern("a.b.c.example.com")).toBeNull();
    });

    test("accepts hostname with hyphens", () => {
      expect(validateHostPattern("my-site.example.com")).toBeNull();
    });

    test("rejects empty string", () => {
      expect(validateHostPattern("")).toBe("Empty host pattern");
    });

    test("rejects bare wildcard", () => {
      const result = validateHostPattern("*");
      expect(result).toContain("Bare wildcard");
    });

    test("rejects hostname with port", () => {
      const result = validateHostPattern("example.com:8080");
      expect(result).toContain("Invalid host pattern");
    });

    test("rejects hostname with protocol", () => {
      const result = validateHostPattern("https://example.com");
      expect(result).toContain("Invalid host pattern");
    });

    test("rejects hostname with path", () => {
      const result = validateHostPattern("example.com/path");
      expect(result).toContain("Invalid host pattern");
    });

    test("rejects hostname with spaces", () => {
      const result = validateHostPattern("example .com");
      expect(result).toContain("Invalid host pattern");
    });

    test("rejects single label hostname", () => {
      const result = validateHostPattern("localhost");
      expect(result).toContain("Invalid host pattern");
    });

    test("rejects double wildcard", () => {
      const result = validateHostPattern("**.example.com");
      expect(result).toContain("Invalid host pattern");
    });

    test("rejects wildcard without dot prefix", () => {
      const result = validateHostPattern("*example.com");
      expect(result).toContain("Invalid host pattern");
    });

    test("rejects uppercase characters", () => {
      const result = validateHostPattern("Example.com");
      expect(result).toContain("Invalid host pattern");
    });
  });

  describe("parseEmbedHosts", () => {
    test("parses comma-separated hosts", () => {
      const result = parseEmbedHosts("example.com, mysite.org");
      expect(result).toEqual(["example.com", "mysite.org"]);
    });

    test("trims whitespace", () => {
      const result = parseEmbedHosts("  example.com ,  mysite.org  ");
      expect(result).toEqual(["example.com", "mysite.org"]);
    });

    test("lowercases entries", () => {
      const result = parseEmbedHosts("Example.COM, MySite.ORG");
      expect(result).toEqual(["example.com", "mysite.org"]);
    });

    test("filters empty entries from trailing comma", () => {
      const result = parseEmbedHosts("example.com,");
      expect(result).toEqual(["example.com"]);
    });

    test("filters empty entries from leading comma", () => {
      const result = parseEmbedHosts(",example.com");
      expect(result).toEqual(["example.com"]);
    });

    test("returns empty array for empty string", () => {
      const result = parseEmbedHosts("");
      expect(result).toEqual([]);
    });

    test("returns empty array for whitespace only", () => {
      const result = parseEmbedHosts("   ");
      expect(result).toEqual([]);
    });
  });

  describe("validateEmbedHosts", () => {
    test("accepts valid comma-separated hosts", () => {
      expect(validateEmbedHosts("example.com, *.mysite.org")).toBeNull();
    });

    test("accepts single host", () => {
      expect(validateEmbedHosts("example.com")).toBeNull();
    });

    test("returns error for invalid host in list", () => {
      const result = validateEmbedHosts("example.com, *");
      expect(result).toContain("Bare wildcard");
    });

    test("returns error for host with port", () => {
      const result = validateEmbedHosts("example.com:443");
      expect(result).toContain("Invalid host pattern");
    });

    test("returns null for empty input (no hosts)", () => {
      expect(validateEmbedHosts("")).toBeNull();
    });
  });

  describe("buildFrameAncestors", () => {
    test("returns null for empty array", () => {
      expect(buildFrameAncestors([])).toBeNull();
    });

    test("builds frame-ancestors with single host", () => {
      expect(buildFrameAncestors(["example.com"])).toBe(
        "frame-ancestors 'self' example.com",
      );
    });

    test("builds frame-ancestors with multiple hosts", () => {
      expect(buildFrameAncestors(["example.com", "*.mysite.org"])).toBe(
        "frame-ancestors 'self' example.com *.mysite.org",
      );
    });
  });
});
