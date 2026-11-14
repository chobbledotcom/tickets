/**
 * The record surface law: a record takes its route ids from its record area,
 * and its JSON audiences from the page routes the surface declares.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { AdminApiResource } from "#shared/admin-api-resources.ts";
import type { AdminDestinationId } from "#shared/admin-surface/ids.ts";
import { adminDestination } from "#shared/admin-surface.ts";
import { attributeRecord } from "#shared/records/attributes.ts";
import { externalSourceRecord } from "#shared/records/external-sources.ts";
import { groupRecord } from "#shared/records/groups.ts";
import { holidayRecord } from "#shared/records/holidays.ts";
import { imageRecord } from "#shared/records/images.ts";
import { listingRecord } from "#shared/records/listings.ts";
import { questionRecord } from "#shared/records/questions.ts";
import { sitePageRecord } from "#shared/records/site-pages.ts";
import { statusRecord } from "#shared/records/statuses.ts";
import {
  deleteAudienceFor,
  jsonAudienceFor,
  recordPageIds,
  recordSurfaceOf,
} from "#shared/rest/record-contract.ts";
import type { AdminLevel } from "#types";

type DeclaredRecord = {
  api?: AdminApiResource;
  deleteDestination?: AdminDestinationId;
  list: AdminDestinationId;
};

const OWNER: readonly AdminLevel[] = ["owner"];
const ALL_ROLES: readonly AdminLevel[] = ["owner", "manager", "editor"];
const OWNER_MANAGER: readonly AdminLevel[] = ["owner", "manager"];
const OWNER_EDITOR: readonly AdminLevel[] = ["owner", "editor"];

/** Each JSON record with the read and delete audiences its pages declare. */
const API_RECORD_AUDIENCES: readonly [
  string,
  DeclaredRecord,
  readonly AdminLevel[],
  readonly AdminLevel[],
][] = [
  ["attribute", attributeRecord, OWNER, OWNER],
  ["externalSource", externalSourceRecord, OWNER, OWNER],
  ["group", groupRecord, ALL_ROLES, OWNER_MANAGER],
  ["holiday", holidayRecord, OWNER, OWNER],
  ["image", imageRecord, ALL_ROLES, ALL_ROLES],
  ["listing", listingRecord, ALL_ROLES, OWNER_MANAGER],
  ["question", questionRecord, OWNER, OWNER],
  ["sitePage", sitePageRecord, OWNER_EDITOR, OWNER_EDITOR],
  ["status", statusRecord, OWNER, OWNER],
];

describe("the record surface law", () => {
  test("every JSON record derives its audiences from its page routes", () => {
    const audiences = API_RECORD_AUDIENCES.map(([name, record]) => {
      if (!record.api) throw new Error(`${record.list} declares no JSON entry`);
      return [name, jsonAudienceFor(record.list), deleteAudienceFor(record)];
    });

    expect(audiences).toEqual(
      API_RECORD_AUDIENCES.map(([name, , read, remove]) => [
        name,
        read,
        remove,
      ]),
    );
  });

  test("a record in a record area takes its route ids from the area", () => {
    expect(recordSurfaceOf("settingsStatuses")).toEqual({
      deleteDestination: "statusDelete",
      detail: "status",
      list: "statuses",
    });
    expect(recordPageIds(statusRecord)).toEqual({
      deleteDestination: "statusDelete",
      destination: "status",
    });
  });

  test("a record outside a record area names its own routes and has no record page", () => {
    const named = { deleteDestination: "imageDelete", list: "images" } as const;
    expect(recordSurfaceOf(named)).toBe(named);
    expect(() => recordPageIds(imageRecord)).toThrow(
      "The record for images declares no record page",
    );
    expect(() =>
      recordPageIds({ deleteDestination: "statusDelete", list: "statuses" }),
    ).toThrow("The record for statuses declares no record page");
    expect(() => recordPageIds({ detail: "status", list: "statuses" })).toThrow(
      "The record for statuses declares no record page",
    );
  });

  test("a record with no delete route takes the collection's delete audience", () => {
    expect(deleteAudienceFor({ list: "images" })).toEqual(ALL_ROLES);
    expect(deleteAudienceFor({ list: "groups" })).toEqual(OWNER_MANAGER);
  });

  test("a declared delete route wins over the collection's delete path", () => {
    expect(
      deleteAudienceFor({ deleteDestination: "statusDelete", list: "images" }),
    ).toEqual(OWNER);
  });

  test("every record names a page route the surface declares", () => {
    for (const [, record] of API_RECORD_AUDIENCES) {
      expect(adminDestination(record.list).pattern).toContain("/admin/");
    }
  });
});
