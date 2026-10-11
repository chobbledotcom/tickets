import { schemaMigration } from "./define.ts";
import { MAINTENANCE_GATE_TRIGGER_NAMES } from "./schema/gate-triggers.ts";

export default schemaMigration(
  "2026-10-11_maintenance_write_gate",
  "Add the maintenance write gate. While the operator's maintenance gate is " +
    "on, triggers refuse every write outside the exempt tables, so an " +
    "update's migrations run without concurrent writes. The runner opens the " +
    "gate for its own writes while a batch runs.",
  { triggers: MAINTENANCE_GATE_TRIGGER_NAMES },
  async ({ syncTriggers }) => {
    await syncTriggers();
  },
);
