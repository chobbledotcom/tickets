import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { infoRedirect, redirect } from "#routes/response.ts";
import { FormParams } from "#shared/form-data.ts";
import { clearFormStash, takeForm } from "#shared/form-stash.ts";
import {
  clearSavedFormData,
  setSavedFormData,
} from "#shared/forms/saved-data.ts";
import { FORM_STASH_MAX_BYTES } from "#shared/limits.ts";
import {
  expectRedirectWithFlash,
  parseFlashCookie,
} from "#test-utils/assertions.ts";

describe("redirect form re-fill stash", () => {
  beforeEach(() => {
    clearFormStash();
    clearSavedFormData();
  });
  afterEach(() => {
    clearFormStash();
    clearSavedFormData();
  });

  const stashedForm = (response: Response): string | null => {
    const { formToken } = parseFlashCookie(response);
    if (formToken === undefined) throw new Error("Expected a form stash token");
    return takeForm(formToken);
  };

  test("stashes captured values without the CSRF token after an error", () => {
    setSavedFormData(new FormParams("name=Alice&csrf_token=secret"));
    const response = redirect(
      "/admin/groups/new",
      "Group Name is required",
      false,
    );
    expect(stashedForm(response)).toBe("name=Alice");
  });

  test("does not stash on success", () => {
    setSavedFormData(new FormParams("name=Bob"));
    const response = redirect("/admin/groups", "Group created", true);
    expect(parseFlashCookie(response).formToken).toBeUndefined();
  });

  test("does not stash when nothing was captured", () => {
    const response = redirect("/admin", "Something went wrong", false);
    expect(parseFlashCookie(response).formToken).toBeUndefined();
  });

  test("does not stash a submission that is only a CSRF token", () => {
    setSavedFormData(new FormParams("csrf_token=secret"));
    const response = redirect(
      "/admin/groups/new",
      "Group Name is required",
      false,
    );
    expect(parseFlashCookie(response).formToken).toBeUndefined();
  });

  test("removes secret fields without changing safe repeated values", () => {
    setSavedFormData(
      new FormParams(
        "name=Bob&name=Alice&monkey=yes&keyword=book&password=hunter2&stripe_secret_key=sk_live_x&api_key=abc&webhook_token=zzz&API_SECRET=private",
      ),
    );
    const response = redirect("/admin/settings", "Invalid key", false);
    expect(stashedForm(response)).toBe(
      "name=Bob&name=Alice&monkey=yes&keyword=book",
    );
  });

  test("skips a submission larger than the size cap", () => {
    setSavedFormData(new FormParams(`bio=${"x".repeat(FORM_STASH_MAX_BYTES)}`));
    const response = redirect("/admin/groups/new", "Too big", false);
    expect(parseFlashCookie(response).formToken).toBeUndefined();
  });

  test("prefers an explicitly supplied form over the capture", () => {
    setSavedFormData(new FormParams("name=captured"));
    const form = new URLSearchParams("name=explicit&csrf_token=secret");
    expect(stashedForm(redirect("/admin/x", "bad", false, { form }))).toBe(
      "name=explicit",
    );
  });

  test("rejects invalid targets before adding flash data", () => {
    expect(() => redirect("http://[::1", "bad", false)).toThrow(
      new TypeError("Invalid redirect URL"),
    );
  });

  test("uses the submitted return URL instead of the default", () => {
    const form = new URLSearchParams({
      return_url: "/admin/groups?tab=list#group",
    });
    const response = redirect("/admin", "Saved", true, { form });
    expectRedirectWithFlash("/admin/groups?tab=list#group", "Saved")(response);
  });

  test("uses the default when the submitted return URL is empty", () => {
    const form = new URLSearchParams({ return_url: "" });
    expectRedirectWithFlash(
      "/admin",
      "Saved",
    )(redirect("/admin", "Saved", true, { form }));
  });

  test("does not carry submitted values into an informational redirect", () => {
    setSavedFormData(new FormParams("name=Bob"));
    const response = infoRedirect("/admin", "No change needed");
    const flash = parseFlashCookie(response);
    expect(flash.info).toBe("No change needed");
    expect(flash.success).toBeUndefined();
    expect(flash.error).toBeUndefined();
    expect(flash.formToken).toBeUndefined();
  });
});
