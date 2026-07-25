// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
import {
  type AttendeeLineInput,
  createTestAttendeeDirect,
  existingAttendeeLines,
  submitAttendeeEdit,
} from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import { testCookie } from "#test-utils/session.ts";

// jscpd:ignore-end

const WORKSHOP = "Workshop";
const REAL_SHOW = "RealShow";
const GHOST_SHOW = "GhostShow";

const listingIdFor = (world: TicketsWorld, name: string): number =>
  requiredWorldValue(world.listingIds.get(name), `${name} listing id`);

const ticketToken = (world: TicketsWorld): string =>
  requiredWorldValue(world.ticketToken, "ticket token");

const addListing = async (
  world: TicketsWorld,
  name: string,
): Promise<number> => {
  const listing = await createTestListing({
    maxAttendees: 50,
    maxQuantity: 5,
    name,
  });
  world.listingIds.set(name, listing.id);
  return listing.id;
};

const giveAttendeeTicket = async (
  world: TicketsWorld,
  listingName: string,
  attendeeName: string,
): Promise<void> => {
  const listingId = await addListing(world, listingName);
  const { attendee, token } = await createTestAttendeeDirect(
    listingId,
    attendeeName,
    `${attendeeName.toLowerCase().replaceAll(" ", ".")}@example.com`,
    2,
  );
  world.attendeeId = attendee.id;
  world.attendeeName = attendeeName;
  world.ticketToken = token;
  expect((await awaitTestRequest(`/t/${token}`)).status).toBe(200);
};

const saveLines = async (
  world: TicketsWorld,
  lines: AttendeeLineInput[],
): Promise<void> => {
  const attendeeId = requiredWorldValue(world.attendeeId, "attendee id");
  const response = await submitAttendeeEdit(attendeeId, {
    lines,
    name: requiredWorldValue(world.attendeeName, "attendee name"),
  });
  if (response.status !== 302) {
    throw new Error(
      `Attendee edit returned ${response.status}: ${await response.text()}`,
    );
  }
};

const changeListingLines = async (
  world: TicketsWorld,
  listingName: string,
  change: (line: AttendeeLineInput) => AttendeeLineInput,
): Promise<void> => {
  const attendeeId = requiredWorldValue(world.attendeeId, "attendee id");
  const listingId = listingIdFor(world, listingName);
  const lines = await existingAttendeeLines(attendeeId);
  if (!lines.some((line) => line.eventId === listingId)) {
    throw new Error(`${listingName} attendee line was not found`);
  }
  await saveLines(
    world,
    lines.map((line) => (line.eventId === listingId ? change(line) : line)),
  );
};

const markNoQuantity = (
  world: TicketsWorld,
  listingName: string,
): Promise<void> =>
  changeListingLines(world, listingName, (line) => ({
    ...line,
    noQuantity: true,
  }));

const attendeeList = async (
  world: TicketsWorld,
  listingName: string,
): Promise<string> => {
  const response = await awaitTestRequest(
    `/admin/listing/${listingIdFor(world, listingName)}/attendees`,
    { cookie: await testCookie() },
  );
  expect(response.status).toBe(200);
  return response.text();
};

const expectNoQuantityWithoutTicket = async (
  world: TicketsWorld,
  listingName: string,
): Promise<void> => {
  const html = await attendeeList(world, listingName);
  expect(html).toContain(
    requiredWorldValue(world.attendeeName, "attendee name"),
  );
  expect(html).toContain("No quantity");
  expect(html).not.toContain(`/t/${ticketToken(world)}`);
};

const expectAttendeeListTicket = async (
  world: TicketsWorld,
  listingName: string,
): Promise<void> => {
  expect(await attendeeList(world, listingName)).toContain(
    `/t/${ticketToken(world)}`,
  );
};

Given(
  "an attendee has a live Workshop ticket",
  function (this: TicketsWorld): Promise<void> {
    return giveAttendeeTicket(this, WORKSHOP, "Ghost Guest");
  },
);

When(
  "the organiser marks the Workshop booking as no quantity",
  function (this: TicketsWorld): Promise<void> {
    return markNoQuantity(this, WORKSHOP);
  },
);

Then(
  "the Workshop attendee list keeps the attendee without a ticket link",
  function (this: TicketsWorld): Promise<void> {
    return expectNoQuantityWithoutTicket(this, WORKSHOP);
  },
);

Then(
  "the old customer ticket is not available",
  async function (this: TicketsWorld): Promise<void> {
    expect((await awaitTestRequest(`/t/${ticketToken(this)}`)).status).toBe(
      404,
    );
  },
);

Given(
  "an attendee's Workshop ticket is unavailable because the booking has no quantity",
  async function (this: TicketsWorld): Promise<void> {
    await giveAttendeeTicket(this, WORKSHOP, "Returning Guest");
    await markNoQuantity(this, WORKSHOP);
    expect((await awaitTestRequest(`/t/${ticketToken(this)}`)).status).toBe(
      404,
    );
  },
);

When(
  "the organiser restores the Workshop quantity to two",
  function (this: TicketsWorld): Promise<void> {
    return changeListingLines(this, WORKSHOP, (line) => ({
      ...line,
      noQuantity: false,
      quantity: 2,
    }));
  },
);

Then(
  "the same customer ticket is available and shows Workshop",
  async function (this: TicketsWorld): Promise<void> {
    const response = await awaitTestRequest(`/t/${ticketToken(this)}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(WORKSHOP);
  },
);

Then(
  "the Workshop attendee list links to that ticket",
  function (this: TicketsWorld): Promise<void> {
    return expectAttendeeListTicket(this, WORKSHOP);
  },
);

Given(
  "an attendee has a live RealShow ticket and GhostShow is also available",
  async function (this: TicketsWorld): Promise<void> {
    await giveAttendeeTicket(this, REAL_SHOW, "Mixed Guest");
    await addListing(this, GHOST_SHOW);
  },
);

When(
  "the organiser keeps GhostShow on the record with no quantity",
  async function (this: TicketsWorld): Promise<void> {
    const attendeeId = requiredWorldValue(this.attendeeId, "attendee id");
    await saveLines(this, [
      ...(await existingAttendeeLines(attendeeId)),
      { eventId: listingIdFor(this, GHOST_SHOW), noQuantity: true },
    ]);
  },
);

Then(
  "the customer ticket shows RealShow but not GhostShow",
  async function (this: TicketsWorld): Promise<void> {
    const response = await awaitTestRequest(`/t/${ticketToken(this)}`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(REAL_SHOW);
    expect(html).not.toContain(GHOST_SHOW);
  },
);

Then(
  "the RealShow attendee list links to the customer ticket",
  function (this: TicketsWorld): Promise<void> {
    return expectAttendeeListTicket(this, REAL_SHOW);
  },
);

Then(
  "the GhostShow attendee list keeps the attendee without a ticket link",
  function (this: TicketsWorld): Promise<void> {
    return expectNoQuantityWithoutTicket(this, GHOST_SHOW);
  },
);
