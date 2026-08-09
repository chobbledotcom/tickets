import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-08-04_login_attempt_stamp",
  "Track when each login-attempt row was last touched.",
  {
    columns: { login_attempts: ["last_attempt"] },
    indexes: ["idx_login_attempts_last_attempt"],
  },
  async ({ getDb }) => {
    // Rows written before this release have no stamp. Start their clock at
    // the migration, so existing counters age out one retention period from
    // now instead of being pruned on the first maintenance run.
    await getDb().execute({
      args: [Date.now()],
      sql: "UPDATE login_attempts SET last_attempt = ? WHERE last_attempt = 0",
    });
  },
);
