import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  builtSiteAction,
  builtSiteTabResult,
} from "#routes/admin/built-site-action.ts";
import { expectRedirectWithFlash } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { mockFormRequest } from "#test-utils/mocks.ts";
import { insertScheduledTestSite } from "#test-utils/scheduled.ts";
import { getTestSession } from "#test-utils/session.ts";

describe("built-site tab results", () => {
  const result = builtSiteTabResult(
    "maintenance",
    (error) => `Could not save: ${error}`,
  )("Saved.");

  test("returns to the selected tab with a success message", () => {
    expectRedirectWithFlash(
      "/admin/built-sites/7/maintenance",
      "Saved.",
    )(result(7, { ok: true }));
  });

  test("returns to the selected tab with the transformed provider error", () => {
    expectRedirectWithFlash(
      "/admin/built-sites/7/maintenance",
      "Could not save: provider failed",
      false,
    )(result(7, { error: "provider failed", ok: false }));
  });
});

describeWithEnv("built-site actions", { db: true }, () => {
  test("loads the site and parsed form for an owner", async () => {
    const site = await insertScheduledTestSite();
    const { cookie, csrfToken } = await getTestSession();
    const route = builtSiteAction((loaded, form, id) =>
      Promise.resolve(
        Response.json({
          id,
          name: loaded.name,
          value: form.getString("value"),
        }),
      ),
    );

    const response = await route(
      mockFormRequest(
        `/admin/built-sites/${site.id}/action`,
        { csrf_token: csrfToken, value: "saved" },
        cookie,
      ),
      { id: site.id },
    );

    expect(await response.json()).toEqual({
      id: site.id,
      name: "Child",
      value: "saved",
    });
  });

  test("rejects an invalid CSRF token before running the action", async () => {
    const site = await insertScheduledTestSite();
    const { cookie } = await getTestSession();
    let called = false;
    const route = builtSiteAction(() => {
      called = true;
      return Promise.resolve(new Response());
    });

    const response = await route(
      mockFormRequest(
        `/admin/built-sites/${site.id}/action`,
        { csrf_token: "wrong" },
        cookie,
      ),
      { id: site.id },
    );

    expect(response.status).toBe(403);
    expect(await response.text()).toBe("CSRF token invalid");
    expect(called).toBe(false);
  });
});
