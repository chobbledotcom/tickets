import { assertArrayIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { adminRedirect, infoRedirect, redirect } from "#routes/response.ts";
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
import { withRequestContext } from "#test-utils/request-context.ts";

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

  test("keeps the submitted return URL, error flash, form anchor and cookie", () =>
    withRequestContext(() => {
      const response = adminRedirect("settings", {}, "Fix fields", false, {
        cookie: "session=abc; Path=/",
        form: new URLSearchParams({
          name: "Submitted",
          return_url: "/admin/listing/8?tab=attendees#old",
        }),
        formId: "contact",
      });
      expectRedirectWithFlash(
        "/admin/listing/8?tab=attendees&form=contact#contact",
        "Fix fields",
        false,
      )(response);
      assertArrayIncludes(response.headers.getSetCookie(), [
        "session=abc; Path=/",
      ]);
      expect(stashedForm(response)).toBe(
        "name=Submitted&return_url=%2Fadmin%2Flisting%2F8%3Ftab%3Dattendees%23old",
      );
    }));

  test("stashes captured values without the CSRF token after an error", async () => {
    await withRequestContext(() => {
      setSavedFormData(new FormParams("name=Alice&csrf_token=secret"));
      const response = redirect(
        "/admin/groups/new",
        "Group Name is required",
        false,
      );
      expect(stashedForm(response)).toBe("name=Alice");
    });
  });

  test("does not stash on success", async () => {
    await withRequestContext(() => {
      setSavedFormData(new FormParams("name=Bob"));
      const response = redirect("/admin/groups", "Group created", true);
      expect(parseFlashCookie(response)).toEqual({ success: "Group created" });
    });
  });

  test("does not stash when nothing was captured", () => {
    const response = redirect("/admin", "Something went wrong", false);
    expect(parseFlashCookie(response)).toEqual({
      error: "Something went wrong",
    });
  });

  test("does not stash a submission that is only a CSRF token", async () => {
    await withRequestContext(() => {
      setSavedFormData(new FormParams("csrf_token=secret"));
      const response = redirect(
        "/admin/groups/new",
        "Group Name is required",
        false,
      );
      expect(parseFlashCookie(response)).toEqual({
        error: "Group Name is required",
      });
    });
  });

  test("removes secret fields without changing safe repeated values", async () => {
    await withRequestContext(() => {
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
  });

  test("skips a submission larger than the size cap", async () => {
    await withRequestContext(() => {
      setSavedFormData(
        new FormParams(`bio=${"x".repeat(FORM_STASH_MAX_BYTES)}`),
      );
      const response = redirect("/admin/groups/new", "Too big", false);
      expect(parseFlashCookie(response)).toEqual({ error: "Too big" });
    });
  });

  test("prefers an explicitly supplied form over the capture", async () => {
    await withRequestContext(() => {
      setSavedFormData(new FormParams("name=captured"));
      const form = new URLSearchParams("name=explicit&csrf_token=secret");
      expect(stashedForm(redirect("/admin/x", "bad", false, { form }))).toBe(
        "name=explicit",
      );
    });
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
    expect(parseFlashCookie(response)).toEqual({ info: "No change needed" });
  });
});
