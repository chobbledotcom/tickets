/** Shared arrange helpers for the admin group route tests. */

import { handleRequest } from "#routes";
import type { GroupInput } from "#shared/catalog-fields/fields.ts";
import { execute } from "#shared/db/client.ts";
import { computeGroupSlugIndex } from "#shared/db/groups.ts";
import type { Group } from "#shared/types.ts";
import { createTestAttendeeDirect } from "#test-utils/db-helpers/attendees.ts";
import {
  createHiddenPackageGroup,
  createTestGroup,
} from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import type { TestFormValues } from "#test-utils/form-values.ts";
import { mockFormRequest } from "#test-utils/mocks.ts";
import { getTestSession } from "#test-utils/session.ts";

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
): Promise<Group> => {
  const group = hidden
    ? await createHiddenPackageGroup(name)
    : await createTestGroup({ isPackage: true, name });
  const member = await createTestListing({
    groupId: group.id,
    maxAttendees: 10,
    name: `${name} member`,
  });
  const { attendee } = await createTestAttendeeDirect(
    member.id,
    `${name} buyer`,
    `${name.toLowerCase().replaceAll(" ", "-")}@example.com`,
  );
  await execute(
    `UPDATE listing_attendees SET package_group_id = ?
      WHERE attendee_id = ?`,
    [group.id, attendee.id],
  );
  return group;
};
