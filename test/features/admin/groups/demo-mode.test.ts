/** Group saves in demo mode: the create and edit forms store a sample name in
 * place of the typed one. */

import { getGroupById, groups } from "#db/groups.ts";
import { DEMO_GROUP_NAMES } from "#shared/demo/samples.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { describeDemoNameSaves } from "#test-utils/demo-name-saves.ts";
import { adminFormPost } from "#test-utils/session.ts";

const groupFields = (name: string) => ({
  description: "",
  max_attendees: "0",
  name,
  terms_and_conditions: "",
});

describeDemoNameSaves({
  createPath: "/admin/groups",
  edit: async (name) => {
    const group = await createTestGroup({ name: "Before" });
    await adminFormPost(`/admin/groups/${group.id}/edit`, {
      ...groupFields(name),
      slug: group.slug,
    });
    groups.cache.invalidate();
    return (await getGroupById(group.id))?.name;
  },
  fields: groupFields,
  label: "group saves in demo mode",
  realName: "Real group",
  samples: DEMO_GROUP_NAMES,
  table: groups.table,
  typedName: "Typed group",
});
