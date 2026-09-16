/** Shared fixtures for the group scanner suites: one group door, its page,
 * and the exact request the page's own script would send. */

import { expect } from "@std/expect";
import { handleRequest } from "#routes";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  adminGet,
  createTestEditorSession,
  requestAsSession,
  testCookie,
  testCsrfToken,
} from "#test-utils/session.ts";

/** One group door with its member listings. Names are unique across the
 * whole site — listings and groups both — so a test that opens two doors
 * must give each its own names. */
export const groupDoor = async (
  memberCount = 3,
  memberOverrides: Parameters<typeof createTestListing>[0] = {},
  names = ["Standard", "Society", "Guest"],
  doorName = "Doors",
) => {
  const group = await createTestGroup({ name: doorName });
  const members = [];
  for (let i = 0; i < memberCount; i++) {
    members.push(
      await createTestListing({
        groupId: group.id,
        maxAttendees: 10,
        name: names[i]!,
        ...memberOverrides,
      }),
    );
  }
  return { group, members };
};

/** A group-door scan as the page's own script would send it. The JSON body
 * is returned unasserted: guards like the missing-group 404 also answer
 * JSON, and each test names the status it expects. */
export const scanAtDoor = async (
  groupId: number,
  body: Record<string, unknown>,
) => {
  const response = await handleRequest(
    requestAsSession(
      `/admin/groups/${groupId}/scan`,
      { cookie: await testCookie(), csrfToken: await testCsrfToken() },
      {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    ),
  );
  return { json: await response.json(), response };
};

/** Someone holding one place on each of two listings in their own separate
 * group — a ticket this door does not own, whatever it scans next. */
export const ticketFromItsOwnGroup = async (
  who: string,
  groupName: string,
): Promise<string> => {
  const { createMultiBookingAttendee } = await import(
    "#test-utils/db-helpers/attendees.ts"
  );
  const own = await createTestGroup({ name: groupName });
  const first = await createTestListing({
    groupId: own.id,
    maxAttendees: 10,
    name: "Quiz",
  });
  const second = await createTestListing({
    groupId: own.id,
    maxAttendees: 10,
    name: "Talk",
  });
  const { ticket_token } = await createMultiBookingAttendee(
    who,
    `${who.toLowerCase()}@example.com`,
    [
      { listingId: first.id, quantity: 1 },
      { listingId: second.id, quantity: 1 },
    ],
  );
  return ticket_token;
};

/** The scanner page for one group door. */
export const doorPage = async (groupId: number): Promise<string> => {
  const response = await adminGet(`/admin/groups/${groupId}/scanner`);
  expect(response.status).toBe(200);
  return await response.text();
};

/** A group-door scan sent by an editor: the gate must refuse before the
 * group is ever looked up, unknown id or not. */
export const editorScan = async (
  groupId: number,
  body: Record<string, unknown>,
): Promise<Response> => {
  const { cookie } = await createTestEditorSession();
  return await handleRequest(
    requestAsSession(
      `/admin/groups/${groupId}/scan`,
      { cookie, csrfToken: "not-needed-past-the-gate" },
      {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    ),
  );
};
