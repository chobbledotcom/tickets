import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { initClosesAtAutofill } from "#src/ui/client/admin/closes-at-autofill.ts";
import { getListingForm } from "#templates/fields/listing.ts";
import {
  createDomInstaller,
  fireEvent,
  requireElement,
} from "#test-utils/happy-dom.ts";

describe("closes-at autofill", () => {
  const dom = createDomInstaller();
  afterEach(() => dom.cleanup());

  /** The listing form as the page renders it, with the script wired, and each
   *  datetime input it reads or fills handed back. */
  const setupForm = () => {
    const window = dom.installDom(getListingForm().render());
    initClosesAtAutofill();
    const input = (name: string) =>
      requireElement<HTMLInputElement>(
        window.document,
        `input[name="${name}"]`,
      );
    return {
      closesAtDate: input("closesAtDate"),
      closesAtTime: input("closesAtTime"),
      date: input("dateDate"),
      time: input("dateTime"),
    };
  };

  /** Pick a value in a part, as the browser reports a picked date or time. */
  const pick = (input: HTMLInputElement, value: string): void => {
    input.value = value;
    fireEvent(input, new Event("change"));
  };

  /** The two closing parts after the operator picks the listing date and time,
   *  with each closing part starting at the value the operator set. */
  const closingAfterListingPick = (
    closingDate: string,
    closingTime: string,
  ): string[] => {
    const form = setupForm();
    form.closesAtDate.value = closingDate;
    form.closesAtTime.value = closingTime;
    pick(form.date, "2026-06-15");
    pick(form.time, "14:30");
    return [form.closesAtDate.value, form.closesAtTime.value];
  };

  test("fills the closing date and time from the listing date", () => {
    expect(closingAfterListingPick("", "")).toEqual(["2026-06-15", "14:30"]);
  });

  test("keeps a closing part that the operator already set", () => {
    expect(closingAfterListingPick("2026-06-01", "09:00")).toEqual([
      "2026-06-01",
      "09:00",
    ]);
  });

  test("keeps the closing date when the listing date is cleared", () => {
    const form = setupForm();
    pick(form.date, "2026-06-15");

    pick(form.date, "");

    expect(form.closesAtDate.value).toBe("2026-06-15");
  });

  test("wires nothing on a page without the listing form", () => {
    dom.installDom("<form><input name='name' value='Spring fair'></form>");

    expect(() => initClosesAtAutofill()).not.toThrow();
  });

  test("wires nothing when the page shows no closing time parts", () => {
    const window = dom.installDom(getListingForm().renderField("date"));

    expect(() => initClosesAtAutofill()).not.toThrow();
    expect(
      window.document.querySelector('input[name="closesAtDate"]'),
    ).toBeNull();
  });
});
