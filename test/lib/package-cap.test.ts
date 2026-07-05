import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  childCanBeBooked,
  childTicketLimit,
  groupCapacityInfo,
  packageLimitInfo,
} from "#shared/booking/package-cap.ts";
import { resolved } from "./booking-model-fixtures.ts";
import { tl } from "./package-cap-fixtures.ts";

describe("groupCapacityInfo", () => {
  test("wraps the remaining and group-id maps together", () => {
    const remaining = new Map([[1, 5]]);
    const groupIds = new Map([[10, [1]]]);
    expect(groupCapacityInfo(remaining, groupIds)).toEqual({
      groupIdsByListingId: groupIds,
      groupRemainingByGroupId: remaining,
    });
  });
});

describe("packageLimitInfo", () => {
  test("combines listings, children, and group capacity into one context", () => {
    const listings = [resolved({ id: 1 })];
    const childrenByParentId = new Map([[1, [resolved({ id: 2 })]]]);
    const remaining = new Map([[5, 3]]);
    const groupIds = new Map([[1, [5]]]);
    expect(
      packageLimitInfo(listings, childrenByParentId, remaining, groupIds),
    ).toEqual({
      childrenByParentId,
      groupIdsByListingId: groupIds,
      groupRemainingByGroupId: remaining,
      listings,
    });
  });
});

describe("childCanBeBooked", () => {
  test("true for an active, open, in-stock child", () => {
    expect(
      childCanBeBooked(
        resolved({ active: true, attendee_count: 0, max_attendees: 10 }),
      ),
    ).toBe(true);
  });

  test("false when inactive", () => {
    expect(childCanBeBooked(resolved({ active: false }))).toBe(false);
  });

  test("false when closed", () => {
    expect(childCanBeBooked(resolved({}, true))).toBe(false);
  });

  test("false when sold out", () => {
    expect(
      childCanBeBooked(resolved({ attendee_count: 1, max_attendees: 1 })),
    ).toBe(false);
  });
});

describe("childTicketLimit", () => {
  const noGroups = groupCapacityInfo(new Map(), new Map());

  test("uses the child's own limit when parent and child share no capped group", () => {
    expect(childTicketLimit(tl(1, 10), tl(2, 4), noGroups)).toBe(4);
  });

  test("uses the parent's own limit for a daily child, regardless of the child's own limit", () => {
    const dailyChild = tl(2, 4, { listing_type: "daily" });
    expect(childTicketLimit(tl(1, 10), dailyChild, noGroups)).toBe(10);
  });

  test("uses the shared group's ticket-pool limit when it's tighter than the child's own limit", () => {
    // PARENT_CHILD_GROUP_UNITS is 2, so a pool of 3 spots fits floor(3/2)=1 ticket.
    const ctx = groupCapacityInfo(
      new Map([[7, 3]]),
      new Map([
        [1, [7]],
        [2, [7]],
      ]),
    );
    expect(childTicketLimit(tl(1, 100), tl(2, 100), ctx)).toBe(1);
  });

  test("uses the child's own limit when it's tighter than the shared group's ticket-pool limit", () => {
    const ctx = groupCapacityInfo(
      new Map([[7, 20]]),
      new Map([
        [1, [7]],
        [2, [7]],
      ]),
    );
    expect(childTicketLimit(tl(1, 100), tl(2, 3), ctx)).toBe(3);
  });
});
