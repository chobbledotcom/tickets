import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { fail, ok } from "#shared/response.ts";
import {
  expectRedirectWithFlash,
  parseFlashCookie,
} from "#test-utils/assertions.ts";

describe("ok", () => {
  test("returns a 302 redirect with success flash cookie", () => {
    const response = ok("/admin/settings", "Saved successfully", {
      formId: "settings-test",
    });

    expectRedirectWithFlash(
      "/admin/settings?form=settings-test#settings-test",
      "Saved successfully",
    )(response);
  });

  test("includes result in flash cookie when provided", () => {
    const response = ok("/admin", "Done", { result: "abc123" });
    expectRedirectWithFlash("/admin", "Done")(response);
    expect(parseFlashCookie(response).result).toBe("abc123");
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

    expectRedirectWithFlash(
      "/admin/settings?form=settings-test#settings-test",
      "Invalid input",
      false,
    )(response);
  });

  test("works without formId", () => {
    const response = fail("/admin", "Something went wrong");
    expectRedirectWithFlash("/admin", "Something went wrong", false)(response);
  });

  test("includes result in flash cookie when provided", () => {
    const response = fail("/admin", "Failed", { result: "err456" });
    expectRedirectWithFlash("/admin", "Failed", false)(response);
    expect(parseFlashCookie(response).result).toBe("err456");
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
