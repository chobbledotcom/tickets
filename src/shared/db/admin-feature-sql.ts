import { sql, sqlJoin, sqlLiteral, type SqlStatement } from "#db/sql.ts";
import { ADMIN_FEATURES } from "#shared/admin-features.ts";

/** SQL that accepts only a complete enabled-feature JSON object. */
export const enabledFeaturesAreValidSql = (value: SqlStatement): SqlStatement =>
  sql`CASE WHEN json_valid(${value})
    THEN COALESCE(${sqlJoin(
      ADMIN_FEATURES.map(
        ({ key }) =>
          sql`json_type(${value}, ${sqlLiteral(`$.${key}`)}) IN ('true', 'false')`,
      ),
      sql`\n      AND `,
    )}, 0)
    ELSE 0
  END = 1`;
