/** Shared arrange helpers for the admin group route tests. */

import { expect } from "@std/expect";
import { handleRequest } from "#routes";
import type { GroupInput } from "#shared/catalog-fields/fields.ts";
import { computeGroupSlugIndex } from "#shared/db/groups.ts";
import type { Group, ListingWithCount } from "#shared/types.ts";
import {
  createSoldPackageMember,
  createTestGroup,
} from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import type { TestFormValues } from "#test-utils/form-values.ts";
import { mockFormRequest } from "#test-utils/mocks.ts";
import { apiRequest, getTestSession } from "#test-utils/session.ts";

/** Post a signed-in admin form and hand back the raw response, so a rejected
 * save can be read from its flash message instead of throwing. */
export const adminPost = async (
  path: string,
  values: TestFormValues,
): Promise<Response> => {
  const session = await getTestSession();
  return handleRequest(
    mockFormRequest(
      path,
      { ...values, csrf_token: session.csrfToken },
      session.cookie,
    ),
  );
};

/** The group input the validators read, with only the fields a test varies.
 * The slug index is the real one-way code for the slug, as a saved group's
 * would be. */
export const groupInput = async (
  overrides: Partial<GroupInput> = {},
): Promise<GroupInput> => {
  const slug = overrides.slug ?? "fresh-name";
  return {
    description: "",
    hidden: false,
    isPackage: false,
    maxAttendees: 0,
    name: "Fresh name",
    termsAndConditions: "",
    ...overrides,
    slug,
    slugIndex: await computeGroupSlugIndex(slug),
  };
};

/** A package with one member and one sold ticket stamped with it. */
export const soldPackage = async (
  name: string,
  hidden: boolean,
): Promise<Group> => (await createSoldPackageMember(name, hidden)).group;

/** Create a package group with one member carrying a `price` override via the
 *  JSON API, returning the group. */
export const packagedGroup = async (
  name: string,
  price: number,
): Promise<Group> => {
  const group = await createTestGroup({ isPackage: true, name });
  const listing = await createTestListing({ groupId: group.id });
  const response = await apiRequest(`/api/admin/groups/${group.id}`, {
    body: {
      is_package: true,
      package_members: [{ listing_id: listing.id, price }],
    },
    method: "PUT",
  });
  expect(response.status).toBe(200);
  return group;
};

/** A fresh group with one member listing, for package PUT tests. */
export const groupWithMember = async (
  name: string,
): Promise<{ group: Group; listing: ListingWithCount }> => {
  const group = await createTestGroup({ name });
  const listing = await createTestListing({ groupId: group.id });
  return { group, listing };
};

/** PUT a group via the JSON API. */
export const putGroup = (
  groupId: number,
  body: Record<string, unknown>,
): Promise<Response> =>
  apiRequest(`/api/admin/groups/${groupId}`, { body, method: "PUT" });
