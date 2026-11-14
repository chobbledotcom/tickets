/** Group saves in demo mode: the create and edit forms store a sample name in
 * place of the typed one. */

import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { getGroupById, groups } from "#db/groups.ts";
import { setDemoModeForTest } from "#shared/demo/mode.ts";
import { DEMO_GROUP_NAMES } from "#shared/demo/samples.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { adminFormPost } from "#test-utils/session.ts";

const groupFields = (name: string) => ({
  description: "",
  max_attendees: "0",
  name,
  terms_and_conditions: "",
});

const createGroup = async (name: string) => {
  await adminFormPost("/admin/groups", groupFields(name));
  const [created] = await groups.table.read.many();
  return created?.name;
};

const editGroup = async (name: string) => {
  const group = await createTestGroup({ name: "Before" });
  await adminFormPost(`/admin/groups/${group.id}/edit`, {
    ...groupFields(name),
    slug: group.slug,
  });
  groups.cache.invalidate();
  return (await getGroupById(group.id))?.name;
};

describeWithEnv("group saves in demo mode", { db: true }, () => {
  afterEach(() => {
    setDemoModeForTest(false);
  });

  test("stores a sample name in place of the typed one on create", async () => {
    setDemoModeForTest(true);
    expect(DEMO_GROUP_NAMES).toContain(await createGroup("Real group"));
  });

  test("stores a sample name in place of the typed one on edit", async () => {
    setDemoModeForTest(true);
    expect(DEMO_GROUP_NAMES).toContain(await editGroup("Real group"));
  });

  test("stores the typed name on create and edit while demo mode is off", async () => {
    expect(await createGroup("Real group")).toBe("Real group");
    expect(await editGroup("Typed group")).toBe("Typed group");
  });
});
