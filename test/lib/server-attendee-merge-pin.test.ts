/**
 * Merging attendees and the pinned location: the pin follows whichever
 * address the operator keeps, and when both sides carry the very same
 * address text (rendered as one "(same)" value on the merge form) the only
 * pin on either side survives instead of being silently dropped.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getAttendee, updateAttendeePII } from "#shared/db/attendees.ts";
import type { Attendee } from "#shared/types.ts";
import {
  adminFormPost,
  adminGet,
  createTestAttendeeDirect,
  createTestListing,
  describeWithEnv,
  extractInputValue,
  getTestPrivateKey,
} from "#test-utils";

/** Set an attendee's address and pin through the production PII writer. */
const setAddressAndPin = (
  attendee: Attendee,
  address: string,
  lat: string,
  lng: string,
): Promise<void> =>
  updateAttendeePII(attendee.id, {
    address,
    email: attendee.email,
    lat,
    lng,
    name: attendee.name,
    payment_id: attendee.payment_id,
    phone: attendee.phone,
    special_instructions: attendee.special_instructions,
    ticket_token: attendee.ticket_token,
  });

/** Extract merge_version from the merge preview HTML page. */
const getMergeVersion = async (
  targetId: number,
  sourceToken: string,
): Promise<string> => {
  const page = await adminGet(
    `/admin/attendees/${targetId}/actions?token=${encodeURIComponent(sourceToken)}`,
  );
  const value = extractInputValue(await page.text(), "merge_version");
  if (value === null) throw new Error("merge_version not found in page");
  return value;
};

/** Create a target + source pair, apply the addresses/pins, and merge with
 * the given extra decision fields. Returns the surviving target. */
const mergeWithPins = async (setup: {
  targetAddress: string;
  targetPin: [string, string];
  sourceAddress: string;
  sourcePin: [string, string];
  decision?: Record<string, string>;
}): Promise<Attendee> => {
  const listingA = await createTestListing({ maxAttendees: 10 });
  const listingB = await createTestListing({ maxAttendees: 10 });
  const { attendee: target } = await createTestAttendeeDirect(
    listingA.id,
    "Target Person",
    "target@example.com",
  );
  const { attendee: source, token: sourceToken } =
    await createTestAttendeeDirect(
      listingB.id,
      "Source Person",
      "source@example.com",
    );
  await setAddressAndPin(target, setup.targetAddress, ...setup.targetPin);
  await setAddressAndPin(source, setup.sourceAddress, ...setup.sourcePin);

  const mergeVersion = await getMergeVersion(target.id, sourceToken);
  const { response } = await adminFormPost(
    `/admin/attendees/${target.id}/merge`,
    {
      merge_version: mergeVersion,
      source_token: sourceToken,
      ...setup.decision,
    },
  );
  expect(response.status).toBe(302);
  return (await getAttendee(target.id, await getTestPrivateKey()))!;
};

describeWithEnv("attendee merge — pinned location", { db: true }, () => {
  test("an identical address keeps the source's only pin", async () => {
    const merged = await mergeWithPins({
      sourceAddress: "1 Shared Street",
      sourcePin: ["51.5", "-0.1"],
      targetAddress: "1 Shared Street",
      targetPin: ["", ""],
    });
    expect(merged.lat).toBe("51.5");
    expect(merged.lng).toBe("-0.1");
  });

  test("the kept side's own pin always wins", async () => {
    const merged = await mergeWithPins({
      sourceAddress: "1 Shared Street",
      sourcePin: ["53.0", "-2.0"],
      targetAddress: "1 Shared Street",
      targetPin: ["51.5", "-0.1"],
    });
    expect(merged.lat).toBe("51.5");
    expect(merged.lng).toBe("-0.1");
  });

  test("keeping an unpinned address over a DIFFERENT pinned one stays unpinned", async () => {
    // The source's pin belongs to the source's address; keeping the target's
    // (different) address must not borrow it.
    const merged = await mergeWithPins({
      sourceAddress: "9 Other Road",
      sourcePin: ["53.0", "-2.0"],
      targetAddress: "1 Target Street",
      targetPin: ["", ""],
    });
    expect(merged.address).toBe("1 Target Street");
    expect(merged.lat).toBe("");
    expect(merged.lng).toBe("");
  });

  test("choosing the source's address brings the source's pin", async () => {
    const merged = await mergeWithPins({
      decision: { pii_address: "source" },
      sourceAddress: "9 Other Road",
      sourcePin: ["53.0", "-2.0"],
      targetAddress: "1 Target Street",
      targetPin: ["51.5", "-0.1"],
    });
    expect(merged.address).toBe("9 Other Road");
    expect(merged.lat).toBe("53.0");
    expect(merged.lng).toBe("-2.0");
  });
});
