import { nowIso } from "#shared/now.ts";
import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-06-20_string_created",
  "Add a created timestamp to encrypted strings so abandoned unused values can be pruned by age",
  {
    columns: {
      strings: ["created"],
    },
  },
  async ({ getDb }) => {
    await getDb().execute({
      args: [nowIso()],
      sql: "UPDATE strings SET created = ? WHERE created = ''",
    });
  },
);
