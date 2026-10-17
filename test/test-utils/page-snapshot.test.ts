import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertThrows } from "@std/assert";
import { afterAll, describe, it } from "@std/testing/bdd";
import { assertPageMatchesSnapshot } from "#test-utils/page-snapshot.ts";

/** The helper reads its expected page from a file, so each case writes its
 *  fixture into a fresh temp dir and compares against it. */
const dir = Deno.makeTempDirSync();
afterAll(() => rmSync(dir, { recursive: true }));

const fixture = (name: string, html: string): URL => {
  const path = join(dir, name);
  writeFileSync(path, html);
  return new URL(`file://${path}`);
};

const page = (token: string, button: string): string =>
  `<form method="post"><input name="csrf_token" type="hidden" value="${token}"><button>${button}</button></form>`;

const adjacentPage = (token: string): string =>
  `<form method="post"><input name="csrf_token" value="${token}"><button>Save</button></form>`;

describe("assertPageMatchesSnapshot", () => {
  it("compares equal when only the freshly minted token value differs", () => {
    assertPageMatchesSnapshot(
      fixture("rendered-order.html", page("signed-from-fixture", "Save")),
      page("signed-from-render", "Save"),
    );
  });

  it("keeps masking the adjacent name and value order", () => {
    assertPageMatchesSnapshot(
      fixture("adjacent.html", adjacentPage("signed-from-fixture")),
      adjacentPage("signed-from-render"),
    );
  });

  it("still fails when the page differs beyond the token", () => {
    assertThrows(() =>
      assertPageMatchesSnapshot(
        fixture("changed.html", page("signed-from-fixture", "Save")),
        page("signed-from-fixture", "Save changes"),
      ),
    );
  });

  it("does not mask a field whose name merely contains csrf_token", () => {
    assertThrows(() =>
      assertPageMatchesSnapshot(
        fixture(
          "lookalike.html",
          '<form method="post"><input data-name="csrf_token" type="hidden" value="keep-a"><button>Save</button></form>',
        ),
        '<form method="post"><input data-name="csrf_token" type="hidden" value="keep-b"><button>Save</button></form>',
      ),
    );
  });
});
