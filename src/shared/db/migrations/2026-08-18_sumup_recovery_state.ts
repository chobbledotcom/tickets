import { nowIso } from "#shared/now.ts";
import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-08-18_sumup_recovery_state",
  "Record what happened to each staged SumUp checkout and when to ask again, so a checkout that was paid while its callback was lost is no longer deleted unchecked",
  {
    columns: { sumup_checkouts: ["next_check_at", "recovery_state"] },
    indexes: ["idx_sumup_checkouts_next_check"],
  },
  async ({ getDb }) => {
    // Every existing row takes the column default, which is only true of the
    // ones that never got a checkout id. A row that has one is a live
    // checkout, and it is due for its first check straight away — this is the
    // backlog the whole feature exists to work through. The reader refuses a
    // staged row that carries an id outright, so this cannot be deferred to a
    // later pass.
    await getDb().execute({
      args: [nowIso()],
      sql: `UPDATE sumup_checkouts
               SET recovery_state = 'waiting', next_check_at = ?
             WHERE sumup_id != '' AND recovery_state = 'staged'`,
    });
  },
);
