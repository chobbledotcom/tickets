import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { hostEmail } from "#shared/email.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { validEmail } from "#test-utils/email.ts";
import { adminGet } from "#test-utils/session.ts";

/** The guide page as the owner sees it. */
const guideHtml = async (path = "/admin/guide"): Promise<string> => {
  const response = await adminGet(path);
  expect(response.status).toBe(200);
  return response.text();
};

describeWithEnv("admin guide routes", { db: true }, () => {
  afterEach(() => {
    hostEmail.resetOverride();
  });

  test("serves the staff guide", async () => {
    assertStringIncludes(await guideHtml(), "Guide");
  });

  test("serves the formatting help on its own route", async () => {
    assertStringIncludes(
      await guideHtml("/admin/formatting"),
      "Text formatting",
    );
  });

  test("serves the Tax and External sources sections", async () => {
    expectIncludesAll(await guideHtml(), [
      '<h3 id="tax">Tax</h3>',
      '<a href="/admin/settings">Settings</a> and find <strong>Tax</strong>',
      '<h3 id="external-sources">External sources</h3>',
      '<a href="/admin/external-sources">External sources</a>',
      "<code>https://diary.example/events/{external_id}</code>",
      '<h3 id="admin-api">Admin API</h3>',
    ]);
  });

  test("shows nothing about host email when the host has none", async () => {
    hostEmail.setOverride(null);
    assert(!(await guideHtml()).includes("host@example.com"));
  });

  test("names the host's from-address and provider when it has them", async () => {
    hostEmail.setOverride({
      apiKey: "key",
      fromAddress: validEmail("host@example.com"),
      provider: "resend",
    });
    const html = await guideHtml();
    expectIncludesAll(html, ["host@example.com", "Resend"]);
  });

  test("turns an unauthenticated visitor away", async () => {
    const { awaitTestRequest } = await import("#test-utils/mocks.ts");
    const response = await awaitTestRequest("/admin/guide");
    expect(response.status).toBe(302);
  });
});
