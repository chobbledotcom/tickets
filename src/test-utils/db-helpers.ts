import { parseFlashValue } from "#shared/cookies.ts";
import { signCsrfToken } from "#shared/csrf.ts";
import { toMajorUnits } from "#shared/currency.ts";
import type { CreateAttendeeResult } from "#shared/db/attendee-types.ts";
import { getAttendeesRaw } from "#shared/db/attendees.ts";
import type { BuiltSiteFormInput } from "#shared/db/built-sites.ts";
import { type EventInput, getEventWithCount } from "#shared/db/events.ts";
import type { GroupInput } from "#shared/db/groups.ts";
import type { HolidayInput } from "#shared/db/holidays.ts";
import type {
  Attendee,
  Event,
  EventWithCount,
  Group,
  Holiday,
} from "#shared/types.ts";
import { testEventInput } from "#test-utils/factories.ts";
import type { BookAttendeeOpts } from "#test-utils/internal.ts";

const bool = (v: unknown): string => (v ? "1" : "");
const optionalNumber = (v: number | null | undefined): string =>
  v != null ? String(v) : "";
const optionalPrice = (v: number | null | undefined): string =>
  v != null ? toMajorUnits(v) : "";
const formatBookableDaysForForm = (days: string[]): string => days.join(",");

const splitClosesAt = (
  update: string | undefined,
  existing: string | null,
): { date: string; time: string } => {
  const value = update !== undefined ? update : (existing?.slice(0, 16) ?? "");
  if (!value) return { date: "", time: "" };
  const [date = "", time = ""] = value.split("T");
  return { date, time };
};

const pickField = <T>(update: T | undefined, existing: T): T =>
  update !== undefined ? update : existing;

const buildCreateEventForm = (
  input: Omit<EventInput, "slug" | "slugIndex">,
): Record<string, string> => {
  const closesAtParts = splitClosesAt(input.closesAt, null);
  const dateParts = splitClosesAt(input.date, null);
  const initialSiteMonths = input.assignBuiltSite
    ? (input.initialSiteMonths ?? 1)
    : (input.initialSiteMonths ?? 0);
  return {
    assign_built_site: bool(input.assignBuiltSite),
    bookable_days: input.bookableDays
      ? formatBookableDaysForForm(input.bookableDays)
      : "",
    can_pay_more: bool(input.canPayMore),
    closes_at_date: closesAtParts.date,
    closes_at_time: closesAtParts.time,
    date_date: dateParts.date,
    date_time: dateParts.time,
    description: input.description ?? "",
    event_type: input.eventType ?? "",
    fields: input.fields ?? "email",
    group_id: String(input.groupId ?? 0),
    hidden: bool(input.hidden),
    initial_site_months: String(initialSiteMonths),
    location: input.location ?? "",
    max_attendees: String(input.maxAttendees),
    max_price: toMajorUnits(input.maxPrice),
    max_quantity: String(input.maxQuantity ?? 1),
    maximum_days_after: optionalNumber(input.maximumDaysAfter),
    minimum_days_before: optionalNumber(input.minimumDaysBefore),
    months_per_unit: String(input.monthsPerUnit ?? 0),
    name: input.name,
    non_transferable: bool(input.nonTransferable),
    purchase_only: bool(input.purchaseOnly),
    thank_you_url: input.thankYouUrl ?? "",
    unit_price: optionalPrice(input.unitPrice),
    webhook_url: input.webhookUrl ?? "",
  };
};

const buildUpdateBoolFields = (
  updates: Partial<EventInput>,
  existing: EventWithCount,
): Record<string, string> => ({
  assign_built_site: bool(
    pickField(updates.assignBuiltSite, existing.assign_built_site),
  ),
  can_pay_more: bool(pickField(updates.canPayMore, existing.can_pay_more)),
  hidden: bool(pickField(updates.hidden, existing.hidden)),
  non_transferable: bool(
    pickField(updates.nonTransferable, existing.non_transferable),
  ),
  purchase_only: bool(pickField(updates.purchaseOnly, existing.purchase_only)),
});

const buildUpdateNumericFields = (
  updates: Partial<EventInput>,
  existing: EventWithCount,
): Record<string, string> => {
  const assignsBuiltSite = pickField(
    updates.assignBuiltSite,
    existing.assign_built_site,
  );
  const initialSiteMonths = assignsBuiltSite
    ? pickField(updates.initialSiteMonths, existing.initial_site_months || 1)
    : pickField(updates.initialSiteMonths, existing.initial_site_months);
  return {
    group_id: String(pickField(updates.groupId, existing.group_id)),
    initial_site_months: String(initialSiteMonths),
    max_attendees: String(
      pickField(updates.maxAttendees, existing.max_attendees),
    ),
    max_price: toMajorUnits(pickField(updates.maxPrice, existing.max_price)),
    max_quantity: String(pickField(updates.maxQuantity, existing.max_quantity)),
    maximum_days_after: String(
      pickField(updates.maximumDaysAfter, existing.maximum_days_after),
    ),
    minimum_days_before: String(
      pickField(updates.minimumDaysBefore, existing.minimum_days_before),
    ),
    months_per_unit: String(
      pickField(updates.monthsPerUnit, existing.months_per_unit),
    ),
    unit_price: formatPrice(updates.unitPrice, existing.unit_price),
  };
};

const buildUpdateStringFields = (
  updates: Partial<EventInput>,
  existing: EventWithCount,
): Record<string, string> => ({
  bookable_days: formatBookableDaysForForm(
    pickField(updates.bookableDays, existing.bookable_days),
  ),
  description: pickField(updates.description, existing.description),
  event_type: pickField(updates.eventType, existing.event_type),
  fields: pickField(updates.fields, existing.fields),
  location: pickField(updates.location, existing.location),
  name: pickField(updates.name, existing.name),
  slug: pickField(updates.slug, existing.slug),
  thank_you_url: formatOptional(updates.thankYouUrl, existing.thank_you_url),
  webhook_url: formatOptional(updates.webhookUrl, existing.webhook_url),
});

const buildUpdateEventForm = (
  updates: Partial<EventInput>,
  existing: EventWithCount,
): Record<string, string> => {
  const closesAtParts = splitClosesAt(updates.closesAt, existing.closes_at);
  const dateParts = splitClosesAt(updates.date, existing.date);
  return {
    ...buildUpdateBoolFields(updates, existing),
    ...buildUpdateNumericFields(updates, existing),
    ...buildUpdateStringFields(updates, existing),
    closes_at_date: closesAtParts.date,
    closes_at_time: closesAtParts.time,
    date_date: dateParts.date,
    date_time: dateParts.time,
  };
};

const formatOptional = (update: string | undefined, existing: string): string =>
  update ?? existing;

const formatPrice = (update: number | undefined, existing: number): string =>
  update !== undefined ? toMajorUnits(update) : toMajorUnits(existing);

async function doAuthenticatedFormRequest<T>(
  path: string,
  formData: Record<string, string>,
  onSuccess: () => Promise<T>,
  errorContext: string,
): Promise<T> {
  const { getTestSession } = await import("#test-utils/session.ts");
  const { handleRequest } = await import("#routes");
  const { mockFormRequest } = await import("#test-utils/mocks.ts");
  const session = await getTestSession();
  const response = await handleRequest(
    mockFormRequest(
      path,
      { ...formData, csrf_token: session.csrfToken },
      session.cookie,
    ),
  );
  response.body?.cancel();
  if (response.status !== 302) {
    throw new Error(`Failed to ${errorContext}: ${response.status}`);
  }
  return onSuccess();
}

async function doAuthenticatedMultipartFormRequest<T>(
  path: string,
  formData: Record<string, string>,
  onSuccess: () => Promise<T>,
  errorContext: string,
): Promise<T> {
  const { getTestSession } = await import("#test-utils/session.ts");
  const { handleRequest } = await import("#routes");
  const { mockMultipartRequest } = await import("#test-utils/mocks.ts");
  const session = await getTestSession();
  const response = await handleRequest(
    mockMultipartRequest(
      path,
      { ...formData, csrf_token: session.csrfToken },
      session.cookie,
    ),
  );
  response.body?.cancel();
  if (response.status !== 302) {
    throw new Error(`Failed to ${errorContext}: ${response.status}`);
  }
  return onSuccess();
}

export const createTestEvent = (
  overrides: Partial<Omit<EventInput, "slug" | "slugIndex">> = {},
): Promise<Event> => {
  const input = testEventInput(overrides);
  return doAuthenticatedMultipartFormRequest(
    "/admin/event",
    buildCreateEventForm(input),
    async () => {
      const { getAllEvents } = await import("#shared/db/events.ts");
      const events = await getAllEvents();
      return events[0] as Event;
    },
    "create event",
  );
};

const allDays: string[] = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

export const priceFormValue = (minorUnits: number): string =>
  toMajorUnits(minorUnits);

export const updateTestEvent = async (
  eventId: number,
  updates: Partial<EventInput>,
): Promise<Event> => {
  const existing = await getEventWithCount(eventId);
  if (!existing) {
    throw new Error(`Event not found: ${eventId}`);
  }
  return doAuthenticatedMultipartFormRequest(
    `/admin/event/${eventId}/edit`,
    buildUpdateEventForm(updates, existing),
    async () => (await getEventWithCount(eventId)) as EventWithCount,
    "update event",
  );
};

const changeEventStatus =
  (action: "deactivate" | "reactivate") =>
  async (eventId: number): Promise<void> => {
    const event = await getEventWithCount(eventId);
    if (!event) {
      throw new Error(`Event not found: ${eventId}`);
    }
    return doAuthenticatedFormRequest(
      `/admin/event/${eventId}/${action}`,
      { confirm_identifier: event.name },
      async () => {},
      `${action} event`,
    );
  };

export const deactivateTestEvent = changeEventStatus("deactivate");
export const reactivateTestEvent = changeEventStatus("reactivate");

export const createTestAttendee = async (
  eventId: number,
  eventSlug: string,
  name: string,
  email: string,
  quantity = 1,
  phone = "",
): Promise<Attendee> => {
  const { handleRequest } = await import("#routes");
  const { mockRequest, mockTicketFormRequest } = await import(
    "#test-utils/mocks.ts"
  );
  const { extractCsrfToken } = await import("#test-utils/csrf.ts");

  const pageResponse = await handleRequest(mockRequest(`/ticket/${eventSlug}`));
  const pageHtml = await pageResponse.text();
  const csrfToken = extractCsrfToken(pageHtml) ?? (await signCsrfToken());

  const response = await handleRequest(
    mockTicketFormRequest(
      eventSlug,
      { email, name, phone, [`quantity_${eventId}`]: String(quantity) },
      csrfToken,
    ),
  );

  if (response.status !== 302 && response.status !== 303) {
    const body = await response.text();
    throw new Error(
      `Failed to create attendee: ${response.status} - ${body.slice(0, 200)}`,
    );
  }

  const flashCookie = response.headers
    .getSetCookie()
    .find((c) => c.startsWith("flash_"));
  if (flashCookie) {
    const cookiePart = flashCookie.split(";")[0] ?? "";
    const value = cookiePart.split("=").slice(1).join("=");
    const parsed = parseFlashValue(value);
    if (parsed.error) {
      response.body?.cancel();
      throw new Error(`Failed to create attendee: ${parsed.error}`);
    }
  }

  response.body?.cancel();

  const afterAttendees = await getAttendeesRaw(eventId);
  return afterAttendees[0] as Attendee;
};

export { getAttendeesRaw };

export const createTestAttendeeDirect = async (
  eventId: number,
  name: string,
  email: string,
  quantity = 1,
  phone = "",
  address = "",
  special_instructions = "",
): Promise<{ attendee: Attendee; token: string }> => {
  const { createAttendeeAtomic } = await import("#shared/db/attendees.ts");

  const result = await createAttendeeAtomic({
    address,
    bookings: [{ eventId, quantity }],
    email,
    name,
    phone,
    special_instructions,
  });

  if (!result.success) {
    throw new Error(`Failed to create attendee: ${result.reason}`);
  }

  return {
    attendee: result.attendees[0]!,
    token: result.attendees[0]!.ticket_token,
  };
};

export const createTestAttendeeWithToken = async (
  name: string,
  email: string,
  eventOverrides: Partial<Omit<EventInput, "slug" | "slugIndex">> = {},
  quantity = 1,
  phone = "",
): Promise<{ event: Event; attendee: Attendee; token: string }> => {
  const event = await createTestEvent({ maxAttendees: 10, ...eventOverrides });
  const { attendee, token } = await createTestAttendeeDirect(
    event.id,
    name,
    email,
    quantity,
    phone,
  );
  return { attendee, event, token };
};

export const createDailyTestEvent = (
  overrides: Partial<Omit<EventInput, "slug" | "slugIndex">> = {},
) =>
  createTestEvent({
    bookableDays: allDays,
    eventType: "daily",
    maxAttendees: 10,
    maximumDaysAfter: 60,
    minimumDaysBefore: 0,
    ...overrides,
  });

export const createPaidTestAttendee = async (
  eventId: number,
  name: string,
  email: string,
  paymentId: string,
  pricePaid = 500,
  quantity = 1,
): Promise<Attendee> => {
  const { createAttendeeAtomic } = await import("#shared/db/attendees.ts");
  const result = await createAttendeeAtomic({
    bookings: [{ eventId, pricePaid, quantity }],
    email,
    name,
    paymentId,
  });
  return (result as { success: true; attendees: Attendee[] }).attendees[0]!;
};

export const bookAttendee = async (
  event: Pick<Event, "id">,
  opts: BookAttendeeOpts = {},
): Promise<CreateAttendeeResult> => {
  const { createAttendeeAtomic } = await import("#shared/db/attendees.ts");
  const booking: import("#shared/db/attendee-types.ts").EventBooking = {
    eventId: event.id,
  };
  if (opts.date !== undefined) booking.date = opts.date;
  if (opts.quantity !== undefined) booking.quantity = opts.quantity;
  if (opts.pricePaid !== undefined) booking.pricePaid = opts.pricePaid;
  return createAttendeeAtomic({
    bookings: [booking],
    email: opts.email ?? "x@example.com",
    name: opts.name ?? "X",
    ...(opts.phone !== undefined && { phone: opts.phone }),
    ...(opts.address !== undefined && { address: opts.address }),
    ...(opts.special_instructions !== undefined && {
      special_instructions: opts.special_instructions,
    }),
    ...(opts.paymentId !== undefined && { paymentId: opts.paymentId }),
  });
};

export const createDailyTestAttendee = async (
  name: string,
  email: string,
  date: string,
  eventOverrides: Partial<Omit<EventInput, "slug" | "slugIndex">> = {},
): Promise<{ event: Event; attendee: Attendee; token: string }> => {
  const { createAttendeeAtomic } = await import("#shared/db/attendees.ts");
  const event = await createDailyTestEvent(eventOverrides);
  const result = await createAttendeeAtomic({
    bookings: [{ date, eventId: event.id }],
    email,
    name,
  });
  const { attendees } = result as Extract<typeof result, { success: true }>;
  const attendee = attendees[0]!;
  return { attendee, event, token: attendee.ticket_token };
};

export const createTestGroup = async (
  overrides: Partial<Omit<GroupInput, "slugIndex">> = {},
): Promise<Group> => {
  const input = {
    description: overrides.description ?? "",
    hidden: overrides.hidden ?? false,
    maxAttendees: overrides.maxAttendees ?? 0,
    name: overrides.name ?? "Test Group",
    termsAndConditions: overrides.termsAndConditions ?? "",
  };

  const group = await doAuthenticatedFormRequest(
    "/admin/groups",
    {
      description: input.description,
      max_attendees: String(input.maxAttendees),
      name: input.name,
      terms_and_conditions: input.termsAndConditions,
      ...(input.hidden ? { hidden: "1" } : {}),
    },
    async () => {
      const { getAllGroups } = await import("#shared/db/groups.ts");
      const groups = await getAllGroups();
      return groups[groups.length - 1] as Group;
    },
    "create group",
  );

  if (overrides.slug) {
    return updateTestGroup(group.id, {
      description: group.description,
      hidden: group.hidden,
      maxAttendees: group.max_attendees,
      name: group.name,
      slug: overrides.slug,
      termsAndConditions: group.terms_and_conditions,
    });
  }

  return group;
};

export const updateTestGroup = async (
  groupId: number,
  updates: Partial<Omit<GroupInput, "slugIndex">>,
): Promise<Group> => {
  const { groupsTable } = await import("#shared/db/groups.ts");
  const existing = (await groupsTable.findById(groupId)) as Group;

  const hidden = updates.hidden ?? existing.hidden;
  return doAuthenticatedFormRequest(
    `/admin/groups/${groupId}/edit`,
    {
      description: updates.description ?? existing.description,
      max_attendees: String(updates.maxAttendees ?? existing.max_attendees),
      name: updates.name ?? existing.name,
      slug: updates.slug ?? existing.slug,
      terms_and_conditions:
        updates.termsAndConditions ?? existing.terms_and_conditions,
      ...(hidden ? { hidden: "1" } : {}),
    },
    async () => {
      const updated = await groupsTable.findById(groupId);
      return updated as Group;
    },
    "update group",
  );
};

export const deleteTestGroup = async (groupId: number): Promise<void> => {
  const { groupsTable } = await import("#shared/db/groups.ts");
  const existing = (await groupsTable.findById(groupId)) as Group;

  return doAuthenticatedFormRequest(
    `/admin/groups/${groupId}/delete`,
    { confirm_identifier: existing.name },
    async () => {},
    "delete group",
  );
};

export const createTestHoliday = (
  overrides: Partial<HolidayInput> = {},
): Promise<Holiday> => {
  const input: HolidayInput = {
    endDate: overrides.endDate ?? "2026-12-25",
    name: overrides.name ?? "Test Holiday",
    startDate: overrides.startDate ?? "2026-12-25",
  };

  return doAuthenticatedFormRequest(
    "/admin/holidays",
    {
      end_date: input.endDate,
      name: input.name,
      start_date: input.startDate,
    },
    async () => {
      const { getAllHolidays } = await import("#shared/db/holidays.ts");
      const holidays = await getAllHolidays();
      return holidays[holidays.length - 1] as Holiday;
    },
    "create holiday",
  );
};

export const updateTestHoliday = async (
  holidayId: number,
  updates: Partial<HolidayInput>,
): Promise<Holiday> => {
  const { holidaysTable } = await import("#shared/db/holidays.ts");
  const existing = (await holidaysTable.findById(holidayId)) as Holiday;

  return doAuthenticatedFormRequest(
    `/admin/holidays/${holidayId}/edit`,
    {
      end_date: updates.endDate ?? existing.end_date,
      name: updates.name ?? existing.name,
      start_date: updates.startDate ?? existing.start_date,
    },
    async () => {
      const updated = await holidaysTable.findById(holidayId);
      return updated as Holiday;
    },
    "update holiday",
  );
};

export const deleteTestHoliday = async (holidayId: number): Promise<void> => {
  const { holidaysTable } = await import("#shared/db/holidays.ts");
  const existing = (await holidaysTable.findById(holidayId)) as Holiday;

  return doAuthenticatedFormRequest(
    `/admin/holidays/${holidayId}/delete`,
    { confirm_identifier: existing.name },
    async () => {},
    "delete holiday",
  );
};

/**
 * Provision a test built site for renewals: writes a fresh token + HMAC index
 * directly via updateBuiltSiteRenewalState. Skips the admin route intentionally
 * — admin-route coverage lives in test/admin-built-sites-actions.test.ts.
 */
export const provisionTestBuiltSite = async (
  siteId: number,
  opts: { readOnlyFrom?: string } = {},
): Promise<{ token: string; tokenIndex: string }> => {
  const { generateRenewalToken } = await import("#shared/site-assignment.ts");
  const { updateBuiltSiteRenewalState } = await import(
    "#shared/db/built-sites.ts"
  );
  const { index, token } = await generateRenewalToken();
  await updateBuiltSiteRenewalState(siteId, {
    renewalToken: token,
    renewalTokenIndex: index,
    ...(opts.readOnlyFrom !== undefined
      ? { readOnlyFrom: opts.readOnlyFrom }
      : {}),
  });
  return { token, tokenIndex: index };
};

export const createTestBuiltSite = (
  overrides: Partial<BuiltSiteFormInput> = {},
): Promise<import("#shared/db/built-sites.ts").BuiltSite> => {
  const input: BuiltSiteFormInput = {
    assignable: overrides.assignable ?? false,
    bunnyScriptId: overrides.bunnyScriptId ?? "",
    bunnyUrl: overrides.bunnyUrl ?? "https://test.b-cdn.net",
    dbToken: overrides.dbToken ?? "",
    dbUrl: overrides.dbUrl ?? "",
    name: overrides.name ?? "Test Site",
  };

  return doAuthenticatedFormRequest(
    "/admin/built-sites",
    {
      bunny_script_id: input.bunnyScriptId,
      bunny_url: input.bunnyUrl,
      db_token: input.dbToken,
      db_url: input.dbUrl,
      name: input.name,
      ...(input.assignable ? { assignable: "1" } : {}),
    },
    async () => {
      const { getAllBuiltSites } = await import("#shared/db/built-sites.ts");
      const sites = await getAllBuiltSites();
      return sites[
        sites.length - 1
      ] as import("#shared/db/built-sites.ts").BuiltSite;
    },
    "create built site",
  );
};

export const updateTestBuiltSite = async (
  siteId: number,
  updates: Partial<BuiltSiteFormInput>,
): Promise<import("#shared/db/built-sites.ts").BuiltSite> => {
  const { builtSitesCrudTable } = await import("#shared/db/built-sites.ts");
  const existing = (await builtSitesCrudTable.findById(
    siteId,
  )) as import("#shared/db/built-sites.ts").BuiltSite;

  const assignable = updates.assignable ?? existing.assignable;
  return doAuthenticatedFormRequest(
    `/admin/built-sites/${siteId}/edit`,
    {
      bunny_script_id: updates.bunnyScriptId ?? existing.bunnyScriptId,
      bunny_url: updates.bunnyUrl ?? existing.bunnyUrl,
      db_token: updates.dbToken ?? existing.dbToken,
      db_url: updates.dbUrl ?? existing.dbUrl,
      name: updates.name ?? existing.name,
      ...(assignable ? { assignable: "1" } : {}),
    },
    async () => {
      const updated = await builtSitesCrudTable.findById(siteId);
      return updated as import("#shared/db/built-sites.ts").BuiltSite;
    },
    "update built site",
  );
};

export const deleteTestBuiltSite = async (siteId: number): Promise<void> => {
  const { builtSitesCrudTable } = await import("#shared/db/built-sites.ts");
  const existing = (await builtSitesCrudTable.findById(
    siteId,
  )) as import("#shared/db/built-sites.ts").BuiltSite;

  return doAuthenticatedFormRequest(
    `/admin/built-sites/${siteId}/delete`,
    { confirm_identifier: existing.name },
    async () => {},
    "delete built site",
  );
};

export const createTestInvite = async (
  username: string,
  adminLevel = "manager",
): Promise<{ inviteCode: string; cookie: string; csrfToken: string }> => {
  const { getTestSession } = await import("#test-utils/session.ts");
  const { handleRequest } = await import("#routes");
  const { mockFormRequest } = await import("#test-utils/mocks.ts");
  const { cookie, csrfToken } = await getTestSession();
  const inviteResponse = await handleRequest(
    mockFormRequest(
      "/admin/users",
      { admin_level: adminLevel, csrf_token: csrfToken, username },
      cookie,
    ),
  );
  inviteResponse.body?.cancel();
  const location = inviteResponse.headers.get("location") ?? "";
  const url = new URL(location, "http://localhost");
  const inviteLink = url.searchParams.get("invite") ?? "";
  const codeMatch = inviteLink.match(/\/join\/([A-Za-z0-9_-]+)/);
  if (!codeMatch?.[1]) {
    throw new Error(
      `Failed to create invite for ${username}: ${inviteResponse.status} ${location}`,
    );
  }
  return { cookie, csrfToken, inviteCode: codeMatch[1] };
};

export const getEmbeddableTicketResponse = async (): Promise<Response> => {
  const { handleRequest } = await import("#routes");
  const { mockRequest } = await import("#test-utils/mocks.ts");
  const event = await createTestEvent({
    maxAttendees: 50,
    thankYouUrl: "https://example.com",
  });
  return handleRequest(mockRequest(`/ticket/${event.slug}`));
};
