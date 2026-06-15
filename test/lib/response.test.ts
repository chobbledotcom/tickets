import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { redirect } from "#routes/response.ts";
import { parseFlashValue } from "#shared/cookies.ts";
import { FormParams } from "#shared/form-data.ts";
import { clearFormStash, takeForm } from "#shared/form-stash.ts";
import { clearSavedFormData, setSavedFormData } from "#shared/forms.tsx";
import { FORM_STASH_MAX_BYTES } from "#shared/limits.ts";
import { fail, ok } from "#shared/response.ts";
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

describe("redirect form re-fill stash", () => {
  const flashTokenOf = (response: Response): string | undefined => {
    const flash = response.headers
      .getSetCookie()
      .find((c) => c.startsWith("flash_"))!;
    const value = flash.split(";")[0]!.split("=").slice(1).join("=");
    return parseFlashValue(value).formToken;
  };

  beforeEach(() => {
    clearFormStash();
    clearSavedFormData();
  });

  afterEach(() => {
    clearFormStash();
    clearSavedFormData();
  });

  test("fail stashes the captured submission and carries its token", () => {
    setSavedFormData(new FormParams("name=Alice&csrf_token=secret"));
    const response = fail("/admin/groups/new", "Group Name is required");
    const token = flashTokenOf(response);
    expect(token).toBeDefined();
    // The CSRF token is stripped; the rest round-trips for re-filling.
    expect(takeForm(token!)).toBe("name=Alice");
  });

  test("ok does not stash on success", () => {
    setSavedFormData(new FormParams("name=Bob"));
    expect(flashTokenOf(ok("/admin/groups", "Group created"))).toBeUndefined();
  });

  test("fail does not stash when nothing was captured", () => {
    expect(
      flashTokenOf(fail("/admin", "Something went wrong")),
    ).toBeUndefined();
  });

  test("fail does not stash a submission that is only a CSRF token", () => {
    setSavedFormData(new FormParams("csrf_token=secret"));
    const response = fail("/admin/groups/new", "Group Name is required");
    expect(flashTokenOf(response)).toBeUndefined();
  });

  test("fail skips a submission larger than the size cap", () => {
    setSavedFormData(new FormParams(`bio=${"x".repeat(FORM_STASH_MAX_BYTES)}`));
    expect(flashTokenOf(fail("/admin/groups/new", "Too big"))).toBeUndefined();
  });

  test("redirect prefers an explicitly supplied form over the capture", () => {
    setSavedFormData(new FormParams("name=captured"));
    const form = new URLSearchParams("name=explicit&csrf_token=secret");
    const token = flashTokenOf(redirect("/admin/x", "bad", false, { form }));
    expect(token).toBeDefined();
    expect(takeForm(token!)).toBe("name=explicit");
  });
});
