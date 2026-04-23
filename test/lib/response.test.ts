import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { parseFlashValue } from "#lib/cookies.ts";
import { fail, ok } from "#lib/response.ts";
import {
  expectFlash,
  expectRedirect,
  expectRedirectWithFlash,
} from "#test-utils";

describe("ok", () => {
  test("returns a 302 redirect with success flash cookie", () => {
    const response = ok("/admin/settings", "Saved successfully", {
      formId: "settings-test",
    });

    expect(response.status).toBe(302);
    const location = expectRedirect(response);
    expect(location).toContain("/admin/settings?flash=");
    expect(location).toContain("form=settings-test");
    expect(location).toContain("#settings-test");
    expectFlash(response, "Saved successfully");
  });

  test("includes result in flash cookie when provided", () => {
    const response = ok("/admin", "Done", { result: "abc123" });
    expectRedirectWithFlash("/admin", "Done")(response);

    const cookies = response.headers.getSetCookie();
    const flash = cookies.find((c) => c.startsWith("flash_"));
    const cookiePart = flash!.split(";")[0] ?? "";
    const value = cookiePart.split("=").slice(1).join("=");
    const parsed = parseFlashValue(value);
    expect(parsed.result).toBe("abc123");
  });

  test("appends additional cookie when provided", () => {
    const response = ok("/admin", "Logged in", {
      cookie: "session=abc; Path=/",
    });
    const cookies = response.headers.getSetCookie();
    const hasSession = cookies.some((c) => c.includes("session=abc"));
    expect(hasSession).toBe(true);
  });

  test("works without optional opts", () => {
    const response = ok("/admin", "Done");
    expectRedirectWithFlash("/admin", "Done")(response);
  });
});

describe("fail", () => {
  test("returns a 302 redirect with error flash cookie", () => {
    const response = fail("/admin/settings", "Invalid input", {
      formId: "settings-test",
    });

    expect(response.status).toBe(302);
    const location = expectRedirect(response);
    expect(location).toContain("/admin/settings?flash=");
    expect(location).toContain("form=settings-test");
    expect(location).toContain("#settings-test");
    expectFlash(response, "Invalid input", false);
  });

  test("works without formId", () => {
    const response = fail("/admin", "Something went wrong");
    expectRedirectWithFlash("/admin", "Something went wrong", false)(response);
  });

  test("includes result in flash cookie when provided", () => {
    const response = fail("/admin", "Failed", { result: "err456" });
    expectRedirectWithFlash("/admin", "Failed", false)(response);

    const cookies = response.headers.getSetCookie();
    const flash = cookies.find((c) => c.startsWith("flash_"));
    const cookiePart = flash!.split(";")[0] ?? "";
    const value = cookiePart.split("=").slice(1).join("=");
    const parsed = parseFlashValue(value);
    expect(parsed.result).toBe("err456");
  });

  test("appends additional cookie when provided", () => {
    const response = fail("/admin", "Auth failed", {
      cookie: "session=; Path=/; Max-Age=0",
    });
    const cookies = response.headers.getSetCookie();
    const hasClearedSession = cookies.some(
      (c) => c.includes("session=;") && c.includes("Max-Age=0"),
    );
    expect(hasClearedSession).toBe(true);
  });
});
