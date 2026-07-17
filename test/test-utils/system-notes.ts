import { encrypt } from "#shared/crypto/encryption.ts";
import { execute, insert } from "#shared/db/client.ts";
import { nowIso } from "#shared/now.ts";

export const createTestSystemNote = async (
  attendeeId: number,
  note: string,
): Promise<void> => {
  const statement = insert("system_notes", {
    attendee_id: attendeeId,
    created: nowIso(),
    note: await encrypt(note),
    type: "system",
  });
  await execute(statement.sql, statement.args);
};
