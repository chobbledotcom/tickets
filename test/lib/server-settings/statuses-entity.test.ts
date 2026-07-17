/* jscpd:ignore-start */
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  attendeeStatuses,
  getAttendeeStatus,
} from "#shared/db/attendee-statuses.ts";
import { RESERVATION_AMOUNT_HINT } from "#shared/reservation-amount.ts";
import {
  expectFlashRedirect,
  expectHtmlResponse,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withEnv } from "#test-utils/env.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";

/* jscpd:ignore-end */

const PATH = "/admin/settings/statuses";
const seedStatus = async () => (await attendeeStatuses.getAll())[0]!;

describeWithEnv("server (attendee status entity page)", { db: true }, () => {
  testRequiresAuth(`${PATH}/1`);

  test("renders the Edit tab at the canonical status URL", async () => {
    const seed = await seedStatus();
    const response = await adminGet(`${PATH}/${seed.id}`);
    await expectHtmlResponse(
      response,
      200,
      seed.name,
      `action="${PATH}/${seed.id}/edit"`,
      `href="${PATH}/${seed.id}/actions"`,
    );
  });

  test("renders delete on the Actions tab", async () => {
    const seed = await seedStatus();
    const response = await adminGet(`${PATH}/${seed.id}/actions`);
    await expectHtmlResponse(
      response,
      200,
      "Actions",
      `${PATH}/${seed.id}/delete`,
    );
  });

  test("returns 404 for an unknown tab", async () => {
    const seed = await seedStatus();
    const response = await adminGet(`${PATH}/${seed.id}/unknown`);
    expect(response.status).toBe(404);
  });

  test("hides the write-only entity page in read-only mode", async () => {
    using _env = withEnv({
      READ_ONLY_FROM: "2020-01-01T00:00:00.000Z",
    });
    const seed = await seedStatus();
    const response = await adminGet(`${PATH}/${seed.id}`);
    expect(response.status).toBe(404);
  });

  test("renames a status", async () => {
    const created = await attendeeStatuses.table.insert({ name: "Old" });
    const { response } = await adminFormPost(`${PATH}/${created.id}/edit`, {
      name: "Renamed",
    });
    await expectFlashRedirect(
      `${PATH}/${created.id}`,
      "Status updated",
    )(response);
    expect((await getAttendeeStatus(created.id))?.name).toBe("Renamed");
  });

  test("refuses to clear the only public default", async () => {
    const seed = await seedStatus();
    const { response } = await adminFormPost(`${PATH}/${seed.id}/edit`, {
      is_paid_default: "1",
      name: "Confirmed",
    });
    await expectHtmlResponse(
      response,
      400,
      "Choose another public default before clearing this one",
      'checked name="is_paid_default"',
    );
  });

  test("pre-fills a reservation status's fields when editing", async () => {
    const reserved = await attendeeStatuses.table.insert({
      isReservation: true,
      name: "Reserved",
      reservationAmount: "25%",
    });
    const html = await (await adminGet(`${PATH}/${reserved.id}/edit`)).text();
    expect(html).toContain('value="25%"');
    expect(html).toContain('checked name="is_reservation"');
  });

  test("returns 404 editing a missing status", async () => {
    const { response } = await adminFormPost(`${PATH}/9999/edit`, {
      name: "Ghost",
    });
    expect(response.status).toBe(404);
  });

  test("rejects an invalid edit with its submitted values", async () => {
    const seed = await seedStatus();
    const { response } = await adminFormPost(`${PATH}/${seed.id}/edit`, {
      is_reservation: "1",
      name: "Submitted name",
      reservation_amount: "lots",
    });
    await expectHtmlResponse(
      response,
      400,
      RESERVATION_AMOUNT_HINT,
      'value="Submitted name"',
      'checked name="is_reservation"',
      'value="lots"',
    );
    expect((await getAttendeeStatus(seed.id))?.name).toBe(seed.name);
  });

  test("does not restore the stored name when an edit omits it", async () => {
    const seed = await seedStatus();
    const { response } = await adminFormPost(`${PATH}/${seed.id}/edit`, {});
    const html = await response.text();

    expect(response.status).toBe(400);
    expect(html).toContain("Please enter a name");
    expect(html).toMatch(/name="name"[^>]*value=""/);
  });

  test("refuses to clear the only paid default", async () => {
    const seed = await seedStatus();
    const { response } = await adminFormPost(`${PATH}/${seed.id}/edit`, {
      is_public_default: "1",
      name: "Confirmed",
    });
    await expectHtmlResponse(
      response,
      400,
      "Choose another paid default before clearing this one",
      'checked name="is_public_default"',
    );
  });
});
