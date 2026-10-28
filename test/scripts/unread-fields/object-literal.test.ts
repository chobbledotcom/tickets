import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { scanUnreadFields } from "#scripts/unread-fields/scan.ts";

/**
 * End to end: the keys an object literal gives a class field reach the
 * report, and a read of one keeps it live.
 */
describe("the keys an object literal gives a class field", () => {
  test("counts a read of a key and reports a key nobody reads", async () => {
    // Issue #2222. `config = { dead: 1 }` puts `dead` in the type a caller
    // reaches as `holder.config.dead`, so the read keeps the key alive and a
    // key nobody reads still reports.
    const root = await Deno.makeTempDir({ prefix: "unread-fields-literal-" });
    try {
      await Deno.mkdir(`${root}/src`);
      await Deno.writeTextFile(`${root}/deno.json`, JSON.stringify({}));
      await Deno.writeTextFile(
        `${root}/src/shapes.ts`,
        `export class Holder {
  config = { dead: 1 };
  unused = { ghost: 2 };
}
`,
      );
      await Deno.writeTextFile(
        `${root}/src/use.ts`,
        `import { Holder } from "./shapes.ts";
export const read = new Holder().config.dead;
`,
      );
      const found = await scanUnreadFields(root);
      expect(found.map((f) => `${f.owner}.${f.field}:${f.verdict}`)).toEqual([
        "Holder.config:read",
        "Holder.config.dead:read",
        "Holder.unused:never read",
        "Holder.unused.ghost:never read",
      ]);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  test("counts a read of a shorthand key and reports one nobody reads", async () => {
    // `{ touched }` writes the key in shorthand. The read reaches it the way
    // it reaches a written-out key. A shorthand key nobody reads still
    // reports.
    const root = await Deno.makeTempDir({ prefix: "unread-fields-shorthand-" });
    try {
      await Deno.mkdir(`${root}/src`);
      await Deno.writeTextFile(`${root}/deno.json`, JSON.stringify({}));
      await Deno.writeTextFile(
        `${root}/src/shapes.ts`,
        `const touched = 1;
const left = 2;
export class Holder {
  config = { touched, left };
}
`,
      );
      await Deno.writeTextFile(
        `${root}/src/use.ts`,
        `import { Holder } from "./shapes.ts";
export const value = new Holder().config.touched;
`,
      );
      const found = await scanUnreadFields(root);
      expect(found.map((f) => `${f.owner}.${f.field}:${f.verdict}`)).toEqual([
        "Holder.config:read",
        "Holder.config.touched:read",
        "Holder.config.left:never read",
      ]);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
});
