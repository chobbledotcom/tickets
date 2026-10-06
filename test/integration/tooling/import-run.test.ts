import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { CurlOptions } from "#cli/curl.ts";
import { runImport } from "#cli/import-run.ts";

/** A catalog with one product in one category. */
const PRODUCT_FRONTMATTER = [
  "---",
  "title: Tumble Tower Hire",
  "filter_attributes:",
  "  - name: Guest Capacity",
  "    value: 50 guests",
  "categories:",
  "  - categories/tarps.md",
  "options:",
  "  - name: 1 Day",
  "    unit_price: 100",
  "---",
].join("\n");

const STAMP = "tickets_id: 41\ntickets_slug: tower-hire\n";
/** The product file with its ids stamped before the closing fence, the way
 *  withTicketsMeta writes them. */
const stamped = (): string => {
  const fence = PRODUCT_FRONTMATTER.lastIndexOf("---");
  return `${PRODUCT_FRONTMATTER.slice(0, fence)}${STAMP}---`;
};
const CATEGORY_FRONTMATTER = "---\ntitle: Tarpaulins\n---\n";

/** Write files (paths relative to the catalog's src/) into a fresh temp
 *  catalog and return its path. */
const seedCatalogFiles = async (
  files: Record<string, string>,
): Promise<string> => {
  const dir = await Deno.makeTempDir();
  await Deno.mkdir(`${dir}/src/products`, { recursive: true });
  await Deno.mkdir(`${dir}/src/categories`, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    await Deno.writeTextFile(`${dir}/src/${name}`, text);
  }
  return dir;
};

/** The one-product, one-category catalog the tests share. */
const seedCatalog = (productText: string): Promise<string> =>
  seedCatalogFiles({
    "categories/tarps.md": CATEGORY_FRONTMATTER,
    "products/tower.md": productText,
  });

type ApiCall = { body: unknown; method: string; path: string };
type Routes = Record<string, (body: unknown) => unknown>;

/** An API client stub that answers from `routes` and records every call. The
 *  route key is "METHOD path"; GET omits the method. */
const scriptedApi = (
  routes: Routes,
): { api: <T>(options: CurlOptions) => Promise<T>; calls: ApiCall[] } => {
  const calls: ApiCall[] = [];
  const api = async <T>(options: CurlOptions): Promise<T> => {
    const key = `${options.method ?? "GET"} ${options.path}`;
    calls.push({
      body: options.body,
      method: options.method ?? "GET",
      path: options.path,
    });
    const handler = routes[key];
    if (!handler) throw new Error(`unexpected API call: ${key}`);
    return handler(options.body) as T;
  };
  return { api, calls };
};

/** Run one import against a catalog with a symlink out of it: `link` writes
 *  what the outside folder needs and places the symlink inside the catalog.
 *  Fails the test unless the import refuses as a plain-file error, and
 *  returns the calls that refusal made. */
const symlinkedCatalogRun = async (
  link: (dir: string, outside: string) => Promise<void>,
): Promise<ApiCall[]> => {
  const [dir, outside] = [await Deno.makeTempDir(), await Deno.makeTempDir()];
  try {
    await Deno.mkdir(`${dir}/src/products`, { recursive: true });
    await link(dir, outside);
    const { api, calls } = scriptedApi({});
    await expect(
      runImport({ dir, plan: false, update: false }, api),
    ).rejects.toThrow(/plain file inside the catalog/);
    return calls;
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
};

const LISTINGS_EMPTY: unknown[] = [];
const GROUPS_EMPTY: unknown[] = [];

/** The listing the import stamps and the attribute with its option, in the
 *  already-on-the-site shape the reuse paths match against. */
const towerHire = { id: 41, name: "Tumble Tower Hire", slug: "tower-hire" };
const guestCapacity = {
  id: 11,
  name: "guest capacity",
  options: [{ id: 21, text: "50 guests" }],
};

/** The three snapshot reads every run opens, each answered with `listings`,
 *  `groups`, and `attributes`. */
const snapshotRoutes = (
  listings: unknown[],
  groups: unknown[],
  attributes: unknown[],
): Routes => ({
  "GET /api/admin/attributes": () => ({ attributes }),
  "GET /api/admin/groups": () => ({ groups }),
  "GET /api/admin/listings": () => ({ listings }),
});

/** The two writes one new attribute needs: the attribute, then its option,
 *  whose create response carries `created`. */
const attributeOptionRoutes = (created: unknown): Routes => ({
  "POST /api/admin/attributes": () => ({
    attribute: { id: 11, name: "Guest Capacity", options: [] },
  }),
  "POST /api/admin/attributes/11/options": () => ({
    attribute: { id: 11, name: "Guest Capacity", options: created },
  }),
});

/** Run one non-plan, non-update import expected to refuse, assert its
 *  refusal message, and return the calls made before the refusal. */
const refusedRun = async (
  dir: string,
  routes: Routes,
  message: string,
): Promise<ApiCall[]> => {
  const { api, calls } = scriptedApi(routes);
  await expect(
    runImport({ dir, plan: false, update: false }, api),
  ).rejects.toThrow(message);
  return calls;
};

const callPaths = (calls: readonly ApiCall[]): string[] =>
  calls.map((call) => `${call.method} ${call.path}`);

/** The three snapshot reads every run opens, in the order they happen. */
const SNAPSHOT_READ_PATHS = [
  "GET /api/admin/listings",
  "GET /api/admin/groups",
  "GET /api/admin/attributes",
];

/** Run one import that must change nothing, and assert it stayed within the
 *  three snapshot reads. Returns the report. */
const readOnlyRun = async (
  dir: string,
  listings: unknown[],
  flags: { plan: boolean; update: boolean } = { plan: false, update: false },
) => {
  const { api, calls } = scriptedApi(
    snapshotRoutes(listings, GROUPS_EMPTY, []),
  );
  const report = await runImport({ dir, ...flags }, api);
  expect(callPaths(calls)).toEqual(SNAPSHOT_READ_PATHS);
  return report;
};

describe("frontmatter import runner", () => {
  test("stops a catalog whose category climbs out of the tree before any API call", async () => {
    const dir = await seedCatalog(
      PRODUCT_FRONTMATTER.replace("categories/tarps.md", "../secret"),
    );
    const calls = await refusedRun(
      dir,
      {},
      'tower.md: category "../secret" must be a bare category file name',
    );
    expect(calls).toEqual([]);
  });

  test("creates the attribute, option, group, and listing, then stamps the file", async () => {
    const dir = await seedCatalog(PRODUCT_FRONTMATTER);
    const { api, calls } = scriptedApi({
      ...snapshotRoutes(LISTINGS_EMPTY, GROUPS_EMPTY, []),
      ...attributeOptionRoutes([{ id: 21, text: "50 guests" }]),
      "POST /api/admin/groups": () => ({
        group: { id: 31, name: "Tarpaulins", slug: "tarpaulins" },
      }),
      "POST /api/admin/listings": () => ({ listing: towerHire }),
    });

    const report = await runImport({ dir, plan: false, update: false }, api);

    expect(report).toEqual({
      conflicts: 0,
      created: { attributes: 1, groups: 1, listings: 1, options: 1 },
      filesUpdated: 1,
      skipped: 0,
      updated: 0,
    });
    expect(callPaths(calls)).toEqual([
      "GET /api/admin/listings",
      "GET /api/admin/groups",
      "GET /api/admin/attributes",
      "POST /api/admin/attributes",
      "POST /api/admin/attributes/11/options",
      "POST /api/admin/groups",
      "POST /api/admin/listings",
    ]);
    const stampedFile = await Deno.readTextFile(`${dir}/src/products/tower.md`);
    expect(stampedFile).toContain("tickets_id: 41");
    expect(stampedFile).toContain("tickets_slug: tower-hire");
  });

  test("reruns without --update as reads only: every product skips", async () => {
    const dir = await seedCatalog(stamped());
    expect((await readOnlyRun(dir, [towerHire])).skipped).toBe(1);
  });

  test("updates an unstamped product when --update names the title match", async () => {
    const dir = await seedCatalog(PRODUCT_FRONTMATTER);
    const { api, calls } = scriptedApi({
      ...snapshotRoutes(
        [towerHire],
        [{ id: 31, is_package: false, name: "Tarpaulins", slug: "tarpaulins" }],
        [guestCapacity],
      ),
      "PUT /api/admin/listings/41": () => ({ listing: towerHire }),
    });

    const report = await runImport({ dir, plan: false, update: true }, api);

    expect(report.updated).toBe(1);
    expect(report.filesUpdated).toBe(1);
    expect(callPaths(calls)).toEqual([
      ...SNAPSHOT_READ_PATHS,
      "PUT /api/admin/listings/41",
    ]);
  });

  test("plans a fresh catalog: reads only, no write call anywhere", async () => {
    const dir = await seedCatalog(PRODUCT_FRONTMATTER);
    expect(
      await readOnlyRun(dir, LISTINGS_EMPTY, { plan: true, update: false }),
    ).toEqual({
      conflicts: 0,
      created: { attributes: 0, groups: 0, listings: 0, options: 0 },
      filesUpdated: 0,
      skipped: 0,
      updated: 0,
    });
  });

  test("plans a stamped catalog as a skip even with --update", async () => {
    const dir = await seedCatalog(stamped());
    expect(
      (await readOnlyRun(dir, [towerHire], { plan: true, update: true }))
        .skipped,
    ).toBe(1);
  });

  test("plans a name conflict as a recorded skip", async () => {
    const dir = await seedCatalog(PRODUCT_FRONTMATTER);
    expect(
      (await readOnlyRun(dir, [towerHire], { plan: true, update: false }))
        .conflicts,
    ).toBe(1);
  });

  test("skips a name conflict and records it", async () => {
    const dir = await seedCatalog(PRODUCT_FRONTMATTER);
    expect(
      (
        await readOnlyRun(dir, [
          { id: 77, name: "Tumble Tower Hire", slug: "tower-hire" },
        ])
      ).conflicts,
    ).toBe(1);
  });

  test("skips an ambiguous title that matches two listings", async () => {
    const dir = await seedCatalog(PRODUCT_FRONTMATTER);
    expect(
      (
        await readOnlyRun(dir, [
          { id: 77, name: "Tumble Tower Hire", slug: "tower-one" },
          { id: 78, name: "Tumble Tower Hire", slug: "tower-two" },
        ])
      ).conflicts,
    ).toBe(1);
  });

  test("refuses a stamp whose tickets id names no listing", async () => {
    const dir = await seedCatalog(stamped());
    const calls = await refusedRun(
      dir,
      snapshotRoutes(LISTINGS_EMPTY, GROUPS_EMPTY, []),
      "tower: tickets_id 41 names no listing on the site; restore the listing or delete the stamp from the file",
    );
    expect(callPaths(calls)).toEqual([
      "GET /api/admin/listings",
      "GET /api/admin/groups",
    ]);
  });

  test("refuses a stamp whose tickets id names a differently named listing", async () => {
    const dir = await seedCatalog(stamped());
    await refusedRun(
      dir,
      snapshotRoutes(
        [{ id: 41, name: "Bouncy Castle", slug: "castle" }],
        GROUPS_EMPTY,
        [],
      ),
      "tower: tickets_id 41 names listing 'Bouncy Castle', not 'Tumble Tower Hire'; delete the stamp from the file or rename one and rerun",
    );
  });

  test("refuses two existing attributes under one name", async () => {
    const dir = await seedCatalog(PRODUCT_FRONTMATTER);
    await refusedRun(
      dir,
      snapshotRoutes(LISTINGS_EMPTY, GROUPS_EMPTY, [
        { id: 11, name: "Guest Capacity", options: [] },
        { id: 12, name: "guest capacity", options: [] },
      ]),
      "attribute 'Guest Capacity' matches 2 existing attributes; rename all but one on the site and rerun",
    );
  });

  test("refuses two options under one text inside one attribute", async () => {
    const dir = await seedCatalog(PRODUCT_FRONTMATTER);
    await refusedRun(
      dir,
      snapshotRoutes(LISTINGS_EMPTY, GROUPS_EMPTY, [
        {
          id: 11,
          name: "Guest Capacity",
          options: [
            { id: 21, text: "50 guests" },
            { id: 22, text: "50 GUESTS" },
          ],
        },
      ]),
      "attribute 'Guest Capacity' has 2 options named '50 guests'; delete all but one on the site and rerun",
    );
  });

  test("refuses an option that the create response did not return", async () => {
    const dir = await seedCatalog(PRODUCT_FRONTMATTER);
    await refusedRun(
      dir,
      {
        ...snapshotRoutes(LISTINGS_EMPTY, GROUPS_EMPTY, []),
        ...attributeOptionRoutes([]),
      },
      "Option '50 guests' missing after create",
    );
  });

  test("refuses two existing groups under one name", async () => {
    const dir = await seedCatalog(PRODUCT_FRONTMATTER);
    await refusedRun(
      dir,
      snapshotRoutes(
        LISTINGS_EMPTY,
        [
          { id: 31, is_package: false, name: "Tarpaulins", slug: "tarps-a" },
          { id: 32, is_package: false, name: "tarpaulins", slug: "tarps-b" },
        ],
        [guestCapacity],
      ),
      "group 'Tarpaulins' matches 2 existing groups; rename all but one on the site and rerun",
    );
  });

  test("refuses to attach products to a package group", async () => {
    const dir = await seedCatalog(PRODUCT_FRONTMATTER);
    await refusedRun(
      dir,
      snapshotRoutes(
        LISTINGS_EMPTY,
        [{ id: 31, is_package: true, name: "Tarpaulins", slug: "tarps" }],
        [guestCapacity],
      ),
      "group 'Tarpaulins' is a package; the catalog needs a separate category group; rename one and rerun",
    );
  });

  test("refuses a category file that is a symlink out of the catalog", async () => {
    // A slug passes its name check while the file under it is a link. The
    // import must never read through one: the plain-file check runs before
    // any site call, so no API request is made at all.
    const calls = await symlinkedCatalogRun(async (dir, outside) => {
      await Deno.mkdir(`${dir}/src/categories`, { recursive: true });
      await Deno.writeTextFile(
        `${dir}/src/products/tower.md`,
        PRODUCT_FRONTMATTER,
      );
      await Deno.writeTextFile(`${outside}/secret.md`, CATEGORY_FRONTMATTER);
      await Deno.symlinkSync(
        `${outside}/secret.md`,
        `${dir}/src/categories/tarps.md`,
      );
    });
    expect(calls).toEqual([]);
  });

  test("refuses a categories directory that is a symlink out of the catalog", async () => {
    // Resolving a linked categories directory would promote its target to
    // the trusted root, so the read must answer to the catalog root's real
    // path, taken once, and refuse before any site call.
    const calls = await symlinkedCatalogRun(async (dir, outside) => {
      await Deno.writeTextFile(
        `${dir}/src/products/tower.md`,
        PRODUCT_FRONTMATTER,
      );
      await Deno.mkdir(`${outside}/cats`, { recursive: true });
      await Deno.writeTextFile(
        `${outside}/cats/tarps.md`,
        CATEGORY_FRONTMATTER,
      );
      await Deno.symlinkSync(`${outside}/cats`, `${dir}/src/categories`);
    });
    expect(calls).toEqual([]);
  });

  test("refuses a product file that is a symlink out of the catalog", async () => {
    // A linked product file must refuse, not be skipped: the silent skip
    // would import nothing while the operator believes the product went up.
    const calls = await symlinkedCatalogRun(async (dir, outside) => {
      await Deno.writeTextFile(`${outside}/secret.md`, PRODUCT_FRONTMATTER);
      await Deno.symlinkSync(
        `${outside}/secret.md`,
        `${dir}/src/products/tower.md`,
      );
    });
    expect(calls).toEqual([]);
  });

  test("refuses two products under one title", async () => {
    const dir = await seedCatalogFiles({
      "categories/tarps.md": CATEGORY_FRONTMATTER,
      "products/tower-2.md": PRODUCT_FRONTMATTER,
      "products/tower.md": PRODUCT_FRONTMATTER,
    });
    const calls = await refusedRun(
      dir,
      snapshotRoutes(LISTINGS_EMPTY, GROUPS_EMPTY, []),
      "duplicate product title 'Tumble Tower Hire' in tower and tower-2",
    );
    expect(calls).toEqual([]);
  });
});
