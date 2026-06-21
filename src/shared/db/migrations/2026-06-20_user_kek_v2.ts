import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-06-20_user_kek_v2",
  "Add kek_version and invite_wrapped_data_key to users so wrapped_data_key is bound to a password-derived KEK (and invited users self-activate at /join), making attendee PII undecryptable from a database dump plus DB_ENCRYPTION_KEY alone",
  {
    columns: { users: ["kek_version", "invite_wrapped_data_key"] },
  },
);
