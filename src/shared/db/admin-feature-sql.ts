import { ADMIN_FEATURES } from "#shared/admin-features.ts";

/** SQL that accepts only a complete enabled-feature JSON object. */
export const enabledFeaturesAreValidSql = (valueSql: string): string =>
  `CASE WHEN json_valid(${valueSql})
    THEN COALESCE(${ADMIN_FEATURES.map(
      ({ key }) => `json_type(${valueSql}, '$.${key}') IN ('true', 'false')`,
    ).join("\n      AND ")}, 0)
    ELSE 0
  END = 1`;
