import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { wordingOf } from "#shared/scanner-words.ts";
import { initManualCheckin } from "#src/ui/client/admin/manual-checkin.ts";
import { fireEvent } from "#test-utils/happy-dom.ts";
import { FORM_WORDS, useManualCheckinPage } from "./fixture.ts";

describe("manual check-in combobox", () => {
  const { dom, fresh, pickedPage, setup } = useManualCheckinPage();

  test("fails loudly on a page without the manual check-in form", () => {
    dom.installDom("<p>Other page</p>");
    expect(() =>
      initManualCheckin({
        csrfToken: "csrf",
        offline: { active: () => false, search: () => null },
        scanPath: "/admin/listing/7/scan",
        searchPath: "/admin/listing/7/scan-search",
        wording: wordingOf(FORM_WORDS),
      }),
    ).toThrow("Missing element: #manual-checkin-input");
  });

  test("arrow keys move through the found people and wrap", async () => {
    const page = await setup();
    page.input.focus();

    const first = page.keydown("ArrowDown");
    expect(first.defaultPrevented).toBe(true);
    expect(page.activeId()).toBe("11");

    page.keydown("ArrowDown");
    page.keydown("ArrowDown");
    expect(page.activeId()).toBe("13");
    page.keydown("ArrowDown");
    expect(page.activeId()).toBe("11");
    page.keydown("ArrowUp");
    expect(page.activeId()).toBe("13");
    expect(page.scrolledIds).toEqual(["11", "12", "13", "11", "13"]);
  });

  test("ArrowUp moves to the prior option when three are visible", async () => {
    const page = await setup();
    page.input.focus();
    page.keydown("ArrowDown");

    page.keydown("ArrowUp");

    expect(page.activeId()).toBe("13");
  });

  test("arrow keys do nothing before a search finds anyone", () => {
    const page = fresh(null);
    page.input.focus();

    const arrow = page.keydown("ArrowDown");

    expect(arrow.defaultPrevented).toBe(true);
    expect(page.activeId()).toBeNull();
    expect(page.scrolledIds).toEqual([]);
    expect(page.listbox.classList.contains("hidden")).toBe(true);
  });

  test("typing clears the pick and closes the stale results", async () => {
    const page = await pickedPage("11");
    page.input.value = "Bea";

    fireEvent(page.input, new page.window.Event("input"));

    expect(page.buttonLabel()).toBe("Search");
    expect(page.listbox.classList.contains("hidden")).toBe(true);
  });

  test("the option list only closes for clicks outside the combobox", async () => {
    const page = await setup();
    page.input.focus();
    expect(page.listbox.classList.contains("hidden")).toBe(false);
    expect(page.input.getAttribute("aria-expanded")).toBe("true");

    fireEvent(page.input, new page.window.Event("click", { bubbles: true }));
    expect(page.listbox.classList.contains("hidden")).toBe(false);

    fireEvent(page.listbox, new page.window.Event("click", { bubbles: true }));
    expect(page.listbox.classList.contains("hidden")).toBe(false);

    page.window.document.body.dispatchEvent(
      new page.window.Event("click", { bubbles: true }),
    );
    expect(page.listbox.classList.contains("hidden")).toBe(true);
  });

  test("clicking an option replaces the current selection", async () => {
    const page = await pickedPage("11");
    expect(page.input.value).toBe("Ada (2 tickets) - Camping · 12 Jun");
    const option = document.querySelector<HTMLElement>("[data-key='12']")!;

    fireEvent(option, new page.window.Event("click", { bubbles: true }));

    expect(page.buttonLabel()).toBe("Check In");
    expect(page.input.value).toBe("Bea (1 pass)");
  });

  test("a pick carries its day and listing beside the name", async () => {
    const page = await setup();
    const option = document.querySelector<HTMLElement>("[data-key='11']")!;

    fireEvent(option, new page.window.Event("click", { bubbles: true }));

    expect(page.buttonLabel()).toBe("Check In");
    expect(page.input.value).toBe("Ada (2 tickets) - Camping · 12 Jun");
  });

  test("Enter selects the active option", async () => {
    const page = await setup();
    page.input.focus();
    page.keydown("ArrowDown");

    const enter = page.keydown("Enter");

    expect(enter.defaultPrevented).toBe(true);
    expect(page.buttonLabel()).toBe("Check In");
    expect(page.input.value).toBe("Ada (2 tickets) - Camping · 12 Jun");
    expect(page.listbox.classList.contains("hidden")).toBe(true);
    expect(page.input.getAttribute("aria-expanded")).toBe("false");
  });

  test("Enter keeps its default action when no option is active", async () => {
    const page = await setup();
    const enter = page.keydown("Enter");
    expect(enter.defaultPrevented).toBe(false);
    expect(page.buttonLabel()).toBe("Search");
  });

  test("other keys keep their default action", async () => {
    const page = await setup();
    const tab = page.keydown("Tab");
    expect(tab.defaultPrevented).toBe(false);
    expect(page.activeId()).toBeNull();
  });

  test("Escape closes the option list", async () => {
    const page = await setup();
    page.input.focus();
    expect(page.listbox.classList.contains("hidden")).toBe(false);

    const escapeEvent = page.keydown("Escape");

    expect(escapeEvent.defaultPrevented).toBe(false);
    expect(page.listbox.classList.contains("hidden")).toBe(true);
    expect(page.input.getAttribute("aria-expanded")).toBe("false");
  });
});
