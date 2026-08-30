import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { denoDeployAppSlug, tursoDatabaseSlug } from "#shared/config.ts";

describe("provider resource slugs", () => {
  test("a deno deploy app slug lowercases and replaces special chars with hyphens", () => {
    expect(denoDeployAppSlug("My Site Name")).toBe("my-site-name");
    expect(denoDeployAppSlug("Hello_World!")).toBe("hello-world");
  });

  test("a deno deploy app slug collapses consecutive hyphens", () => {
    expect(denoDeployAppSlug("a  b  c")).toBe("a-b-c");
  });

  test("a deno deploy app slug strips leading and trailing hyphens", () => {
    expect(denoDeployAppSlug("--leading")).toBe("leading");
    expect(denoDeployAppSlug("trailing--")).toBe("trailing");
  });

  test("a deno deploy app slug truncates to 32 chars", () => {
    expect(denoDeployAppSlug("a".repeat(40)).length).toBeLessThanOrEqual(32);
  });

  test("a deno deploy app slug ends clean when truncation lands on a separator", () => {
    const slug = denoDeployAppSlug("Tickets - 12345678901234567890123 A");
    expect(slug.endsWith("-")).toBe(false);
    expect(slug.length).toBeLessThanOrEqual(32);
  });

  test("a deno deploy app slug pads short slugs to at least 3 chars", () => {
    expect(denoDeployAppSlug("ab")).toBe("abapp");
    expect(denoDeployAppSlug("a")).toBe("aapp");
  });

  test("a turso database slug lowercases and replaces non-slug chars", () => {
    expect(tursoDatabaseSlug("My Site")).toBe("my-site");
    expect(tursoDatabaseSlug("Test_DB 123")).toBe("test-db-123");
  });

  test("a turso database slug collapses consecutive hyphens and trims", () => {
    expect(tursoDatabaseSlug("--My--Site--")).toBe("my-site");
  });

  test("a turso database slug truncates to 63 characters", () => {
    expect(tursoDatabaseSlug("a".repeat(100))).toBe("a".repeat(63));
  });

  test("a turso database slug ends clean when truncation lands on a separator", () => {
    const slug = tursoDatabaseSlug(`${"a".repeat(62)}-b`);
    expect(slug.endsWith("-")).toBe(false);
    expect(slug.length).toBeLessThanOrEqual(63);
  });

  test("a turso database slug falls back to db for names that reduce to empty", () => {
    expect(tursoDatabaseSlug("---")).toBe("db");
  });
});
