import { hmacHash } from "#shared/crypto/hashing.ts";
import { executeBatch, getDb, insert } from "#shared/db/client.ts";
import { nowMs } from "#shared/now.ts";

export const insertString = async (
  textIndex: string,
  created: string,
  usedCount: number,
): Promise<void> => {
  await getDb().execute(
    insert("strings", {
      created,
      encrypted_text: "ciphertext",
      text_index: textIndex,
      used_count: usedCount,
    }),
  );
};

export const insertStrings = (
  prefix: string,
  created: string,
  count: number,
): Promise<void> =>
  executeBatch(
    Array.from({ length: count }, (_, index) =>
      insert("strings", {
        created,
        encrypted_text: "ciphertext",
        text_index: `${prefix}-${index}`,
        used_count: 0,
      }),
    ),
  );

export const stringExists = async (textIndex: string): Promise<boolean> => {
  const { rows } = await getDb().execute({
    args: [textIndex],
    sql: "SELECT 1 FROM strings WHERE text_index = ?",
  });
  return rows.length > 0;
};

export const insertLoginAttempt = async (
  ipPlain: string,
  attempts: number,
  lockedUntil: number | null,
): Promise<string> => {
  const ipHash = await hmacHash(ipPlain);
  await getDb().execute({
    args: [ipHash, attempts, lockedUntil],
    sql: "INSERT INTO login_attempts (ip, attempts, locked_until) VALUES (?, ?, ?)",
  });
  return ipHash;
};

export const loginAttemptExists = async (ipHash: string): Promise<boolean> => {
  const { rows } = await getDb().execute({
    args: [ipHash],
    sql: "SELECT 1 FROM login_attempts WHERE ip = ?",
  });
  return rows.length > 0;
};

export const insertTokenAttempt = async (
  ipPlain: string,
  lockedUntil: number | null,
  lastAttempt: number,
): Promise<string> => {
  const ipHash = await hmacHash(ipPlain);
  await getDb().execute({
    args: [ipHash, "[]", lockedUntil, lastAttempt, lastAttempt],
    sql: "INSERT INTO token_attempts (ip, recent_tokens, locked_until, window_start, last_attempt) VALUES (?, ?, ?, ?, ?)",
  });
  return ipHash;
};

export const tokenAttemptExists = async (ipHash: string): Promise<boolean> => {
  const { rows } = await getDb().execute({
    args: [ipHash],
    sql: "SELECT 1 FROM token_attempts WHERE ip = ?",
  });
  return rows.length > 0;
};

export const insertContactPreference = async (
  hash: string,
  unsubscribed: number,
  lastActivity: number,
): Promise<void> => {
  await getDb().execute({
    args: [hash, unsubscribed, lastActivity],
    sql: "INSERT INTO contact_preferences (contact_hash, unsubscribed, visits, stats_blob, last_activity) VALUES (?, ?, 1, '', ?)",
  });
};

export const contactPreferenceExists = async (
  hash: string,
): Promise<boolean> => {
  const { rows } = await getDb().execute({
    args: [hash],
    sql: "SELECT 1 FROM contact_preferences WHERE contact_hash = ?",
  });
  return rows.length > 0;
};

export const insertOrphanAttendee = async (
  createdIso: string,
): Promise<number> => {
  const result = await getDb().execute(
    insert("attendees", {
      created: createdIso,
      pii_blob: "",
      ticket_token_index: `prune-orphan-${crypto.randomUUID()}`,
    }),
  );
  return Number(result.lastInsertRowid);
};

export const attendeeExists = async (id: number): Promise<boolean> => {
  const { rows } = await getDb().execute({
    args: [id],
    sql: "SELECT 1 FROM attendees WHERE id = ?",
  });
  return rows.length > 0;
};

export const oldOrphanIso = (): string =>
  new Date(nowMs() - 365 * 24 * 60 * 60 * 1000).toISOString();
