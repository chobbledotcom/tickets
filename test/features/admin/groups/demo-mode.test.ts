/** Group saves in demo mode: the create and edit forms store a sample name in
 * place of the typed one. */

import { getGroupById, groups } from "#db/groups.ts";
import { tables } from "#db/select/tables.ts";
import { DEMO_GROUP_NAMES } from "#shared/demo/samples.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { describeDemoNameSaves } from "#test-utils/demo-name-saves.ts";
import { adminFormPost } from "#test-utils/session.ts";

const groupFields = (name: string) => ({
  description: "",
  maxAttendees: "0",
  name,
  termsAndConditions: "",
});

describeDemoNameSaves({
  createPath: "/admin/groups",
  edit: async (name) => {
    const group = await createTestGroup({ name: "Before" });
    await adminFormPost(`/admin/groups/${group.id}/edit`, {
      ...groupFields(name),
      slug: group.slug,
    });
    groups.invalidate();
    return (await getGroupById(group.id))?.name;
  },
  fields: groupFields,
  label: "group saves in demo mode",
  realName: "Real group",
  samples: DEMO_GROUP_NAMES,
  table: tables.groups,
  typedName: "Typed group",
});
