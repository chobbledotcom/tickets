/** The effect vocabulary and the pure core, as data.
 *
 * A module carries an effect when it can reach — through static or
 * dynamic imports — one of that effect's roots, or is one itself. The
 * graph lives in `graph.ts`; this file only declares the boundaries.
 *
 * A new boundary module (a new SDK wrapper, a new socket) joins the root
 * list of its effect here. A module joins the pure core deliberately, with
 * the `// effects: pure` line: it must hold no path to any root, and
 * removing the line is a visible change. */

/** One operational effect a module can carry. `db` reaches the database,
 * `net` opens a network connection, `clock` reads the wall clock. */
export type EffectName = "clock" | "db" | "net";

/** The modules that open each boundary, by alias specifier. */
export const EFFECT_ROOTS: Readonly<Record<EffectName, readonly string[]>> = {
  clock: ["#shared/now.ts"],
  db: ["#db/client.ts", "#db/database-client.ts"],
  net: [
    "#db/database-client.ts",
    "#shared/fetch.ts",
    "#shared/sentry-sdk.ts",
    "#shared/storage.ts",
    "#shared/stripe.ts",
    "#shared/turso-api.ts",
    "#shared/update.ts",
    "#shared/uptime-kuma/socket.ts",
  ],
};

/** The line that puts a module in the pure core: the money paths, the
 * machines, the schemas, and their helpers. A pure module must not reach
 * any effect root. */
export const PURE_MARKER = "// effects: pure";

/** The module carries the pure marker on a line of its own. */
export const carriesPureMarker = (content: string): boolean =>
  content.split("\n").some((line) => line === PURE_MARKER);
