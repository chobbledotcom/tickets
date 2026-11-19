import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { Locator, Page } from "playwright";
import { ensureMessageGroups, t } from "#i18n";
import { MESSAGE_GROUPS } from "#locales/message-groups.generated.ts";
import { postImageUpload } from "#test-utils/admin-images.ts";
import {
  describeWithBrowser,
  withSignedInPage,
} from "#test-utils/browser-contract.ts";
import { testCookie, testCsrfToken } from "#test-utils/session.ts";

await ensureMessageGroups(MESSAGE_GROUPS);

const uploadImage = async (): Promise<void> => {
  const response = await postImageUpload(
    "/admin/images",
    await testCookie(),
    await testCsrfToken(),
    "Hero",
  );
  expect(response.status).toBe(302);
};

const openImage = async (page: Page): Promise<Locator> => {
  await page.getByRole("link", { name: "Hero" }).click();
  const dialog = page.locator("dialog.admin-modal");
  await dialog.locator('input[name="name"]').waitFor();
  return dialog;
};

const expectInsideViewport = async (page: Page): Promise<void> => {
  await page.waitForFunction(() => {
    const dialog = document.querySelector("dialog.admin-modal");
    if (dialog === null) return false;
    const box = dialog.getBoundingClientRect();
    return (
      box.top >= 0 &&
      box.left >= 0 &&
      box.bottom <= innerHeight + 0.5 &&
      box.right <= innerWidth + 0.5
    );
  });
};

// Keep the real surface available for the review without a shared output path.
const capture = async (page: Page, name: string): Promise<void> => {
  await Deno.mkdir(".scratch", { recursive: true });
  const path = `.scratch/image-library-${name}-${crypto.randomUUID()}.png`;
  await page.screenshot({ path });
  console.log(`Image library screenshot: ${path}`);
};

describeWithBrowser(
  "the served image library",
  { db: true, storage: "local" },
  (contract) => {
    test("keeps a tall form reachable, preserves edits on reopen, and saves through the real POST", async () => {
      await uploadImage();
      await withSignedInPage(
        contract.browser,
        contract.baseUrl,
        async (page) => {
          page.on("dialog", (dialog) => dialog.accept());
          await page.setViewportSize({ height: 600, width: 1200 });
          await page.goto("/admin/images");
          const dialog = await openImage(page);
          await expectInsideViewport(page);
          expect(
            await dialog.evaluate((element) => element.matches(":modal")),
          ).toBe(false);
          const body = dialog.locator(".admin-modal-body");
          expect(
            await body.evaluate(
              (element) => element.scrollHeight > element.clientHeight,
            ),
          ).toBe(true);
          const name = dialog.locator('input[name="name"]');
          await name.fill("Updated");
          await dialog
            .getByRole("button", { exact: true, name: t("modal.minimise") })
            .click();
          await page.getByRole("link", { name: "Hero" }).click();
          await dialog.locator(".admin-modal-title").click();
          expect(await name.inputValue()).toBe("Updated");
          await capture(page, "desktop");
          await dialog
            .getByRole("button", { exact: true, name: t("modal.close") })
            .click();
          await dialog.waitFor({ state: "detached" });
          expect(
            await page
              .getByRole("link", { name: "Hero" })
              .evaluate((element) => element === document.activeElement),
          ).toBe(true);

          const reopened = await openImage(page);
          await reopened.locator('input[name="name"]').fill("Updated");
          const altText = "A long image description. ".repeat(8);
          await reopened
            .getByRole("textbox", { name: t("images.field.alt_text") })
            .fill(altText);
          await reopened
            .getByRole("button", { name: t("common.save_changes") })
            .click();
          await page.waitForURL((url) => url.pathname === "/admin/images");
          await page.getByRole("link", { name: "Updated" }).waitFor();
          expect(await page.locator("dialog.admin-modal").count()).toBe(0);
          expect(
            await page
              .getByText(t("images.updated"), { exact: true })
              .textContent(),
          ).toBe(t("images.updated"));
          const alt = page.locator(".image-library-alt");
          expect(await alt.textContent()).toBe(altText.trim());
          expect(
            await alt.evaluate((element) => element.scrollHeight),
          ).toBeGreaterThan(
            await alt.evaluate((element) => element.clientHeight),
          );
          await alt.focus();
          expect(
            await alt.evaluate((element) => element === document.activeElement),
          ).toBe(true);
          await alt.press("ArrowDown");
          await page.waitForFunction(() => {
            const scroller = document.querySelector(".image-library-alt");
            return scroller !== null && scroller.scrollTop > 0;
          });
          expect(
            await alt.evaluate((element) => element.scrollTop),
          ).toBeGreaterThan(0);
        },
      );
    });

    test("opens the full login page after the session expires", async () => {
      await uploadImage();
      await withSignedInPage(
        contract.browser,
        contract.baseUrl,
        async (page) => {
          await page.goto("/admin/images");
          await page.context().clearCookies();
          await page.getByRole("link", { name: "Hero" }).click();
          await page.waitForURL((url) => url.pathname === "/admin");
          await page.locator('input[name="username"]').waitFor();
          expect(page.url()).not.toContain("modal=1");
          expect(await page.locator("dialog.admin-modal").count()).toBe(0);
        },
      );
    });

    test("opens the standalone edit page from the keyboard", async () => {
      await uploadImage();
      await withSignedInPage(
        contract.browser,
        contract.baseUrl,
        async (page) => {
          await page.goto("/admin/images");
          const link = page.getByRole("link", { name: "Hero" });
          const editPath = await link.getAttribute("href");
          if (editPath === null) throw new Error("The image has no edit path");
          await link.focus();
          await page.keyboard.press("Enter");
          await page.waitForURL(
            (url) => url.pathname === editPath && url.search === "",
          );
          expect(await page.locator("dialog.admin-modal").count()).toBe(0);
          expect(await page.locator('input[name="name"]').inputValue()).toBe(
            "Hero",
          );
        },
      );
    });

    test("shows the full-screen form and its save control on a phone", async () => {
      await uploadImage();
      await withSignedInPage(
        contract.browser,
        contract.baseUrl,
        async (page) => {
          await page.setViewportSize({ height: 667, width: 375 });
          await page.goto("/admin/images");
          const dialog = await openImage(page);
          await expectInsideViewport(page);
          expect(await dialog.boundingBox()).toEqual({
            height: 667,
            width: 375,
            x: 0,
            y: 0,
          });
          const save = dialog.getByRole("button", {
            name: t("common.save_changes"),
          });
          await save.scrollIntoViewIfNeeded();
          const box = await save.boundingBox();
          if (box === null) throw new Error("The save control has no page box");
          expect(box.y + box.height).toBeLessThanOrEqual(667);
          expect(box.y).toBeGreaterThanOrEqual(0);
          await capture(page, "phone");
        },
      );
    });
  },
);
