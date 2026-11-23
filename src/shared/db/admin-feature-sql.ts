// effects: pure
import { type SqlStatement, sql, sqlJoin, sqlLiteral } from "#db/sql.ts";
import { ADMIN_FEATURES } from "#shared/admin-features.ts";

/** SQL that accepts a stored enabled-feature JSON object when every key it
 *  names is a boolean. A newer release can add a feature key that is absent.
 *  `parseEnabledFeatures` reads an absent key as off, so a missing key must
 *  not refuse a feature-backed write. */
export const enabledFeaturesAreValidSql = (value: SqlStatement): SqlStatement =>
  sql`CASE WHEN json_valid(${value})
    THEN CASE WHEN json_type(${value}) = 'object'
      THEN COALESCE(${sqlJoin(
        ADMIN_FEATURES.map(({ key }) => {
          const type = sql`json_type(${value}, ${sqlLiteral(`$.${key}`)})`;
          return sql`(${type} IS NULL OR ${type} IN ('true', 'false'))`;
        }),
        sql`\n      AND `,
      )}, 0)
      ELSE 0
    END
    ELSE 0
  END = 1`;
