/**
 * Branch cover for the run-sheet template route, beside the run sheet's own
 * rendering tests.
 *
 * These own what only the route can prove: both boxes are kept together, a
 * template the site cannot read is refused while naming the box to fix, and a
 * cleared box goes back to the built-in wording.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import { handleRequest } from "#routes";
import {
  expectFlash,
  expectRedirectWithFlash,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { mockFormRequest } from "#test-utils/mocks.ts";
import { testCookie, testCsrfToken } from "#test-utils/session.ts";
import {
  describeAdminSettings,
  settingsAsStored,
} from "#test-utils/settings.ts";

const PATH = "/admin/settings/logistics-run-sheet";
const FORM_ID = "settings-logistics-run-sheet";
const NOTHING_KEPT = { body: "", heading: "" };
const UNREADABLE = "{% for x in items %}unclosed";

describeAdminSettings(() => {
  const postTemplates = async (fields: Record<string, string>) =>
    await handleRequest(
      mockFormRequest(
        PATH,
        { ...fields, csrf_token: await testCsrfToken() },
        await testCookie(),
      ),
    );

  const storedTemplates = async (): Promise<{
    body: string;
    heading: string;
  }> => {
    await settingsAsStored();
    return {
      body: settings.logisticsRunSheetBody,
      heading: settings.logisticsRunSheetHeading,
    };
  };

  testRequiresAuth(PATH, {
    body: { body: "{{ day.date }}", heading: "{{ date }}" },
    method: "POST",
  });

  test("keeps both templates as the owner wrote them", async () => {
    const response = await postTemplates({
      body: "{% for booking in day.bookings %}{{ booking.name }}{% endfor %}",
      heading: "{{ relative }} — {{ date_label }}",
    });

    expectRedirectWithFlash(
      `/admin/settings-advanced?form=${FORM_ID}#${FORM_ID}`,
      "Logistics run sheet template updated",
    )(response);
    expect(await storedTemplates()).toEqual({
      body: "{% for booking in day.bookings %}{{ booking.name }}{% endfor %}",
      heading: "{{ relative }} — {{ date_label }}",
    });
  });

  test("refuses a day heading the site cannot read, and keeps nothing", async () => {
    const response = await postTemplates({
      body: "",
      heading: UNREADABLE,
    });

    expect(response.status).toBe(302);
    expectFlash(
      response,
      expect.stringContaining("Invalid template syntax in the day heading"),
      false,
    );
    expect(await storedTemplates()).toEqual(NOTHING_KEPT);
  });

  test("refuses a day body the site cannot read, and keeps nothing", async () => {
    const response = await postTemplates({
      body: UNREADABLE,
      heading: "{{ date }}",
    });

    expect(response.status).toBe(302);
    expectFlash(
      response,
      expect.stringContaining("Invalid template syntax in the day body"),
      false,
    );
    expect(await storedTemplates()).toEqual(NOTHING_KEPT);
  });

  test("clearing both boxes puts the built-in wording back", async () => {
    await postTemplates({ body: "{{ day.date }}", heading: "{{ date }}" });
    await postTemplates(NOTHING_KEPT);

    expect(await storedTemplates()).toEqual(NOTHING_KEPT);
  });

  test("treats a send carrying no fields at all as clearing both boxes", async () => {
    await postTemplates({ body: "{{ day.date }}", heading: "{{ date }}" });
    await postTemplates({});

    expect(await storedTemplates()).toEqual(NOTHING_KEPT);
  });
});
