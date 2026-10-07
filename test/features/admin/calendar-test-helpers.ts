/** Shared page and booking helpers for the admin calendar page tests. */
import { addDays } from "#shared/dates.ts";
import { todayInTz } from "#shared/timezone.ts";
import { submitTicketForm } from "#test-utils/csrf.ts";
import { testDate } from "#test-utils/dates.ts";
import { adminGet } from "#test-utils/session.ts";

export const tomorrow = () => addDays(testDate(todayInTz("UTC")), 1);

export async function fetchCalendarHtml(path = "/admin/calendar") {
  const response = await adminGet(path);
  return response.text();
}

export async function fetchCalendarResponse(path = "/admin/calendar") {
  return adminGet(path);
}

export async function bookDailyTicket(
  slug: string,
  opts: { name: string; email: string; date: string },
) {
  await submitTicketForm(slug, opts);
}
