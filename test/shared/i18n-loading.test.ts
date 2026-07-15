import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  ensureMessageGroups,
  resetI18nForTest,
  t,
  withMessageGroups,
} from "#i18n";
import {
  ENGLISH_MESSAGE_LOADERS,
  MESSAGE_GROUPS,
  type MessageLoader,
} from "#locales/manifest.ts";
import { allEnglishMessages, withColdMessages } from "#test-utils/i18n.ts";

const withCommonLoader = (
  loader: MessageLoader,
  run: () => Promise<void>,
): Promise<void> =>
  withColdMessages(async () => {
    const original = ENGLISH_MESSAGE_LOADERS.common;
    ENGLISH_MESSAGE_LOADERS.common = loader;
    try {
      await run();
    } finally {
      ENGLISH_MESSAGE_LOADERS.common = original;
      resetI18nForTest(true);
    }
  });

const duplicateMessageLoader = async (): Promise<Record<string, string>> => ({
  "common.before_duplicate": "Must not remain",
  "public.not_found.title": "Duplicate",
});

const expectDuplicateMessageError = async (
  load: () => Promise<unknown>,
): Promise<void> => {
  await expect(load()).rejects.toThrow(
    'Message key "public.not_found.title" belongs to both en/system and en/common',
  );
};

describe("lazy message groups", () => {
  test("loads only the requested message group", () =>
    withColdMessages(async () => {
      expect(t("public.not_found.title")).toBe("Not Found");
      expect(() => t("common.yes")).toThrow(
        'Missing translation for key "common.yes"',
      );

      await ensureMessageGroups(["common"]);

      expect(t("common.yes")).toBe("Yes");
      expect(() => t("admin.dashboard.guide_link")).toThrow(
        'Missing translation for key "admin.dashboard.guide_link"',
      );
    }));

  test("keeps messages and compiled formats when another group loads", () =>
    withColdMessages(async () => {
      await ensureMessageGroups(["common"]);
      expect(t("linked_items.heading", { count: 2 })).toBe("Linked items (2):");

      await ensureMessageGroups(["errors"]);

      expect(t("linked_items.heading", { count: 3 })).toBe("Linked items (3):");
      expect(t("error.name_required")).toBe("Name is required");
    }));

  test("shares one in-flight load between concurrent requests", () => {
    let loads = 0;
    return withCommonLoader(
      async () => {
        loads++;
        return { "common.concurrent": "Loaded once" };
      },
      async () => {
        await Promise.all([
          ensureMessageGroups(["common"]),
          ensureMessageGroups(["common"]),
        ]);
        await ensureMessageGroups(["common"]);

        expect(loads).toBe(1);
        expect(t("common.concurrent")).toBe("Loaded once");
      },
    );
  });

  test("retries a group after its loader fails", () => {
    let loads = 0;
    return withCommonLoader(
      async () => {
        loads++;
        if (loads === 1) throw new Error("copy unavailable");
        return { "common.retry": "Loaded after retry" };
      },
      async () => {
        await expect(ensureMessageGroups(["common"])).rejects.toThrow(
          "copy unavailable",
        );
        await ensureMessageGroups(["common"]);

        expect(loads).toBe(2);
        expect(t("common.retry")).toBe("Loaded after retry");
      },
    );
  });

  test("rejects a message key owned by two groups", () =>
    withCommonLoader(duplicateMessageLoader, () =>
      expectDuplicateMessageError(() => ensureMessageGroups(["common"])),
    ));

  test("keeps no messages from a rejected catalog", () =>
    withCommonLoader(duplicateMessageLoader, async () => {
      await expectDuplicateMessageError(() => ensureMessageGroups(["common"]));

      expect(() => t("common.before_duplicate")).toThrow(
        'Missing translation for key "common.before_duplicate"',
      );
    }));

  test("catalog-wide loading rejects a message key owned by two groups", () =>
    withCommonLoader(duplicateMessageLoader, () =>
      expectDuplicateMessageError(() =>
        allEnglishMessages(["system", "common"]),
      ),
    ));

  test("rejects a non-string catalog value", () =>
    withCommonLoader(
      async () =>
        ({ "common.invalid": 42 }) as unknown as Record<string, string>,
      async () => {
        await expect(ensureMessageGroups(["common"])).rejects.toThrow(
          'en/common message "common.invalid" is not a string',
        );
      },
    ));

  test("hides copy an earlier request loaded but this route did not declare", async () => {
    await ensureMessageGroups(MESSAGE_GROUPS);

    await withMessageGroups(["common"], async () => {
      await Promise.resolve();
      expect(t("common.yes")).toBe("Yes");
      expect(() => t("admin.dashboard.guide_link")).toThrow(
        'Missing translation for key "admin.dashboard.guide_link"',
      );
    });

    expect(t("admin.dashboard.guide_link")).toBe("Dashboard guide");
  });

  test("loads a group before entering its route scope", () =>
    withCommonLoader(
      async () => ({ "common.scoped_load": "Loaded for route" }),
      async () => {
        await withMessageGroups(["common"], () => {
          expect(t("common.scoped_load")).toBe("Loaded for route");
        });
      },
    ));

  test("uses ICU apostrophe escaping even without a placeholder", () =>
    withCommonLoader(
      async () => ({ "common.icu_apostrophe": "It''s ready" }),
      async () => {
        await ensureMessageGroups(["common"]);
        expect(t("common.icu_apostrophe")).toBe("It's ready");
      },
    ));
});
