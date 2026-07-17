/** Triggers that track every checkout-stage change with one revision number. */

import type { Trigger } from "./types.ts";

const CHECKOUT_STAGE_REVISION_USES = {
  checkout_stage_revisions: ["id", "revision"],
  checkout_stages: [],
} as const;

const revisionTrigger = (action: "INSERT" | "UPDATE" | "DELETE"): Trigger => {
  const name = `trg_checkout_stages_revision_${action.toLowerCase()}`;
  return {
    name,
    sql: `CREATE TRIGGER IF NOT EXISTS ${name}
AFTER ${action} ON checkout_stages
FOR EACH ROW
BEGIN
  INSERT INTO checkout_stage_revisions (id, revision) VALUES (1, 1)
  ON CONFLICT(id) DO UPDATE SET revision = revision + 1;
END`,
    table: "checkout_stages",
    uses: CHECKOUT_STAGE_REVISION_USES,
  };
};

export const CHECKOUT_STAGE_REVISION_TRIGGERS: Trigger[] = [
  revisionTrigger("INSERT"),
  revisionTrigger("UPDATE"),
  revisionTrigger("DELETE"),
];
