import type { Client } from "@libsql/client";

const SQL_PARTS =
  /--[^\r\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[()]|[\w$\u0080-\uffff]+/g;
const COMMAND = /^(?:SELECT|INSERT|UPDATE|DELETE|REPLACE)$/i;

/** Read the final statement after a CTE for write detection and safe read retries. */
export const writeSqlOf = (sql: string): string => {
  if (!/^\s*WITH\b/i.test(sql)) return sql;
  // The SDK has no SQL parser. Ignore quoted text and comments, and count
  // parentheses so a nested SELECT cannot hide the final write command.
  let depth = 0;
  for (const part of sql.matchAll(SQL_PARTS)) {
    const word = part[0];
    if (word === "(") depth++;
    else if (word === ")") depth--;
    else if (depth === 0 && COMMAND.test(word)) return sql.slice(part.index);
  }
  return sql;
};

export const sqlOf = (
  statement: Parameters<Client["batch"]>[0][number],
): string =>
  typeof statement === "string"
    ? statement
    : Array.isArray(statement)
      ? statement[0]
      : statement.sql;

export const isReadSql = (sql: string): boolean =>
  /^\s*select\b/i.test(writeSqlOf(sql));
