/**
 * The four attendee paths that carry no record id, asked as themselves.
 *
 * Each is bound by its own key in the area's route table. A key that stopped
 * naming its path would leave the page unreachable, which is what these ask.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { describeWithEnv } from "#test-utils/db.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";

describeWithEnv("the attendee pages every listing shares", { db: true }, () => {
  test("serves the attendee list", async () => {
    const response = await adminGet("/admin/attendees");

    expect(response.status).toBe(200);
  });

  test("serves the list as a spreadsheet", async () => {
    const response = await adminGet("/admin/attendees/csv");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
  });

  test("serves the form for adding one without a listing in hand", async () => {
    const response = await adminGet("/admin/attendees/new");

    expect(response.status).toBe(200);
  });

  test("takes that form back", async () => {
    // Nothing is filled in, so the form comes straight back with the reason on
    // it, rather than the submission going through.
    const { response } = await adminFormPost("/admin/attendees/new", {});

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("required");
  });
});
