import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { redirect } from "#routes/response.ts";
import { parseFlashValue } from "#shared/cookies.ts";
import { FormParams } from "#shared/form-data.ts";
import { clearFormStash, takeForm } from "#shared/form-stash.ts";
import { clearSavedFormData, setSavedFormData } from "#shared/forms.tsx";
import { FORM_STASH_MAX_BYTES } from "#shared/limits.ts";
import { fail, ok } from "#shared/response.ts";
import { expectRedirectWithFlash, parseFlashCookie } from "#test-utils";

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

  test("fail strips secret fields (password, keys, tokens) from the stash", () => {
    setSavedFormData(
      new FormParams(
        "name=Bob&password=hunter2&stripe_secret_key=sk_live_x&api_key=abc&webhook_token=zzz",
      ),
    );
    const token = flashTokenOf(fail("/admin/settings", "Invalid key"));
    expect(token).toBeDefined();
    // Only the non-secret field survives for re-filling.
    expect(takeForm(token!)).toBe("name=Bob");
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

  test("redirect rejects invalid targets before adding flash data", () => {
    expect(() => redirect("http://[::1", "bad", false)).toThrow(TypeError);
  });
});
