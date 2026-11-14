/**
 * The standard Edit / Actions page of one admin record. The record gives the
 * read, the page and delete addresses, and the nav section. The page module
 * gives only the edit panel.
 */

import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { Raw } from "#jsx/jsx-runtime.ts";
import { recordEditPage } from "#routes/admin/record-edit-page.ts";
import { holidayRecord } from "#shared/records/holidays.ts";
import {
  expectHtmlResponse,
  expectIncludesAll,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestHoliday } from "#test-utils/db-helpers/holidays.ts";
import { getTestAuthSession } from "#test-utils/session.ts";

const holidayPageWith = (navActive?: string) =>
  recordEditPage(holidayRecord, {
    deleteLabelKey: "holidays.delete.submit",
    edit: (holiday) =>
      Promise.resolve(Raw({ html: `<p>Editing ${holiday.name}</p>` })),
    ...(navActive ? { navActive } : {}),
  });

/** Renders the page's `tab` for record `id` as the owner. */
const renderHolidayPage = async (
  id: number,
  tab: string,
  navActive?: string,
): Promise<Response> =>
  holidayPageWith(navActive).renderPage(await getTestAuthSession(), id, tab);

/** Stores a holiday called `name`, then renders the page's `tab` for it and
 * checks that the page loads. */
const holidayPage = async (
  name: string,
  tab: string,
  navActive?: string,
): Promise<{ id: number; html: string }> => {
  const { id } = await createTestHoliday({ name });
  return {
    html: await expectHtmlResponse(
      await renderHolidayPage(id, tab, navActive),
      200,
    ),
    id,
  };
};

describeWithEnv("a record edit page", { db: true }, () => {
  test("reads the record and links its tabs by the record id", async () => {
    const { html, id } = await holidayPage("Boxing Day", "");

    expectIncludesAll(html, [
      "<h1>Boxing Day</h1>",
      "<p>Editing Boxing Day</p>",
      `href="/admin/holidays/${id}/edit"`,
      `href="/admin/holidays/${id}/actions"`,
    ]);
  });

  test("leads the delete action to the record's delete route", async () => {
    const { html, id } = await holidayPage("New Year", "actions");

    assertStringIncludes(html, `href="/admin/holidays/${id}/delete"`);
  });

  test("marks the record's list in the nav when no section is given", async () => {
    const { html } = await holidayPage("Easter", "");

    assertStringIncludes(html, '<a class="active" href="/admin/holidays">');
  });

  test("marks the given nav section in place of the record's list", async () => {
    const { html } = await holidayPage("Whitsun", "", "/admin/settings");

    assertStringIncludes(html, '<a href="/admin/holidays">');
    expect(html).not.toContain('<a class="active" href="/admin/holidays">');
  });

  test("answers 404 for a record that is not there", async () => {
    expect((await renderHolidayPage(99999, "")).status).toBe(404);
  });
});
