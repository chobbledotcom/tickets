import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getRequestClientIp, runWithClientIp } from "#shared/client-context.ts";

describe("client-context", () => {
  test("returns the bound IP inside a scope", () => {
    const ip = runWithClientIp("203.0.113.7", () => getRequestClientIp());
    expect(ip).toBe("203.0.113.7");
  });

  test("falls back to 'direct' outside any request scope", () => {
    expect(getRequestClientIp()).toBe("direct");
  });
});
