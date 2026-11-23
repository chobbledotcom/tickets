// Demo mode has no switch on the public surface, so this claim stays a direct
// test. test/blackbox/settings-texts.test.ts covers the rest of the form.
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { setDemoModeForTest } from "#shared/demo/mode.ts";
import { DEMO_PAGE_TEXT } from "#shared/demo/samples.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";
import { describeAdminSettings } from "#test-utils/settings.ts";

/** The demo sample texts that the settings page shows. */
const samplesShown = async (): Promise<string[]> => {
  const page = await (await adminGet("/admin/settings")).text();
  return DEMO_PAGE_TEXT.filter((sample) => page.includes(sample));
};

describeAdminSettings(() => {
  test("demo mode saves sample text in place of the typed site footer", async () => {
    expect(await samplesShown()).toEqual([]);
    setDemoModeForTest(true);
    const { response } = await adminFormPost("/admin/settings/site-footer", {
      siteFooter: "Call Dana on 555-0139",
    });
    expect(response.status).toBe(302);

    setDemoModeForTest(false);
    const page = await (await adminGet("/admin/settings")).text();
    expect(page).not.toContain("Call Dana on 555-0139");
    expect(await samplesShown()).toHaveLength(1);
  });
});
