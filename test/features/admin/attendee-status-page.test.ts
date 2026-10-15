/**
 * The attendee-status record page: its two tabs, and what a rejected edit
 * keeps. The page is a declaration over the shared entity-page framework, so
 * these ask the routes it produces rather than the fields it sets.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { attendeeStatuses } from "#db/attendee-statuses.ts";
import { FormParams } from "#shared/form-data.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { says } from "#test-utils/says.ts";
import { adminGet, getTestAuthSession } from "#test-utils/session.ts";

const PATH = "/admin/settings/statuses";

/** The seed status the migration creates. */
const seedStatus = async () => (await attendeeStatuses.getAll())[0]!;

describeWithEnv("the attendee status page", { db: true }, () => {
  test("opens on the edit form for the status named in the path", async () => {
    const status = await seedStatus();

    const response = await adminGet(`${PATH}/${status.id}`);
    const html = await response.text();

    expect(response.status).toBe(200);
    says(html, `action="${PATH}/${status.id}/edit"`);
    says(html, status.name);
  });

  test("marks the statuses list as the section it belongs to", async () => {
    const status = await seedStatus();

    const html = await (await adminGet(`${PATH}/${status.id}`)).text();

    says(html, `<a class="active" href="${PATH}">`);
  });

  test("offers deleting the status on its actions tab", async () => {
    const status = await seedStatus();

    const response = await adminGet(`${PATH}/${status.id}/actions`);
    const html = await response.text();

    expect(response.status).toBe(200);
    says(html, `href="${PATH}/${status.id}/delete"`);
    says(html, "Delete status");
  });

  test("answers 404 for a status that is not there", async () => {
    expect((await adminGet(`${PATH}/99999`)).status).toBe(404);
  });

  test("keeps a rejected edit's values and says why it was rejected", async () => {
    // A failed save re-renders the form in place rather than redirecting, so
    // the operator does not lose what they typed.
    const status = await seedStatus();
    const { attendeeStatusPage } = await import(
      "#routes/admin/attendee-status-page.ts"
    );

    const response = await attendeeStatusPage.renderEditError(
      status.id,
      await getTestAuthSession(),
      new FormParams({ name: "Half typed" }),
      "Name is already taken",
    );
    const html = await response.text();

    expect(response.status).toBe(400);
    says(html, "Half typed");
    says(html, "Name is already taken");
  });
});
