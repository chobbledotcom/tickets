import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { TestBrowser } from "#test-utils/test-browser.ts";
import { postedPathBrowser, recordingBrowser } from "./helpers.ts";

describe("TestBrowser submitting the one form that posts to an address", () => {
  /** Two rows' worth of identical arrows — the shape this exists for, where
   * the button's own words cannot tell one row from another. */
  const arrows = (secondArrow: string, method = ' method="POST"') => `
    <form action="/rows/1/move-up" method="POST"><input name="csrf" value="tok">
      <button type="submit">▲</button></form>
    <form action="/rows/2/move-up"${method}><input name="csrf" value="tok2">
      ${secondArrow}</form>
  `;

  const SECOND_ROW = "/rows/2/move-up";
  const pressable = '<button type="submit">▲</button>';

  /** The two ways a row's own arrow can be one nobody could press: nothing on
   * it submits at all, or what does submit would not post to this address. */
  const NOTHING_TO_PRESS = `The form posting to "${SECOND_ROW}" cannot be submitted`;
  const NOT_A_POST = `No button on the form at "${SECOND_ROW}" posts there`;

  /** What the page renders as the second row's arrow, and what pressing that
   * row really does — it goes to the row's own address, or it is refused with
   * these words and nothing is sent at all. */
  const PRESSES: Array<{
    arrow: string;
    method?: string;
    refusedWith?: string;
    what: string;
  }> = [
    {
      arrow: "<button>▲</button>",
      what: "presses a button that names no type, which submits by default",
    },
    {
      arrow: `<button type="submit" formaction="/rows/2/delete">✕</button>
        ${pressable}`,
      what: "presses the one button of several that really posts there",
    },
    {
      arrow: pressable,
      method: "",
      refusedWith: NOT_A_POST,
      what: "refuses a form that would send by GET, having declared no method",
    },
    {
      arrow: '<button type="submit" formmethod="get">▲</button>',
      refusedWith: NOT_A_POST,
      what: "refuses a button that would send its own form by GET",
    },
    {
      arrow: '<button type="submit" formaction="/rows/2/delete">▲</button>',
      refusedWith: NOT_A_POST,
      what: "refuses a button that would send its form somewhere else",
    },
    {
      arrow: '<button disabled type="submit">▲</button>',
      refusedWith: NOTHING_TO_PRESS,
      what: "refuses a form whose only button is switched off",
    },
    {
      arrow: '<button type="button">▲</button>',
      refusedWith: NOTHING_TO_PRESS,
      what: "refuses a form whose only button is not a submit button",
    },
    {
      arrow: '<button type="reset">▲</button>',
      refusedWith: NOTHING_TO_PRESS,
      what: "refuses a form whose only button is a reset button",
    },
  ];

  for (const press of PRESSES) {
    it(press.what, async () => {
      const { browser, postedPath } = postedPathBrowser();
      browser.currentHtml = arrows(press.arrow, press.method);

      const pressed = browser.submitFormAt(SECOND_ROW);

      if (press.refusedWith === undefined) {
        await pressed;
        expect(postedPath()).toBe(SECOND_ROW);
        return;
      }
      await expect(pressed).rejects.toThrow(press.refusedWith);
      expect(postedPath()).toBe("");
    });
  }

  it("finds the row whose button aims there, not the one declaring it", async () => {
    const { browser, sent } = recordingBrowser();
    // No form declares this address; the second row's button aims there, which
    // is the address a person pressing it really lands on.
    browser.currentHtml = `
      <form action="/rows/1/move-up" method="POST"><input name="csrf" value="tok">
        <button type="submit">▲</button></form>
      <form action="/rows/2/edit" method="POST"><input name="csrf" value="tok2">
        <button type="submit" name="go" value="up" formaction="${SECOND_ROW}">▲</button></form>
    `;

    await browser.submitFormAt(SECOND_ROW);

    expect(sent().path).toBe(SECOND_ROW);
    const carried = new URLSearchParams(sent().body);
    expect(carried.get("csrf")).toBe("tok2");
    // A browser sends the pressed button's own name and value with the form.
    expect(carried.get("go")).toBe("up");
  });

  it("sends that form's own hidden fields, not the first row's", async () => {
    const { browser, sent } = recordingBrowser();
    browser.currentHtml = arrows(pressable);

    await browser.submitFormAt(SECOND_ROW);

    expect(sent().path).toBe(SECOND_ROW);
    expect(new URLSearchParams(sent().body).get("csrf")).toBe("tok2");
  });

  it("gives back only the body of the form a button belongs to", () => {
    const browser = new TestBrowser();
    browser.currentHtml = `
      <form action="/one"><input name="only_here" value="1">
        <button type="submit">Save</button></form>
      <form action="/two"><input name="elsewhere" value="2">
        <button type="submit">Publish</button></form>
    `;

    const body = browser.formBodyFor("Publish");

    expect(body).toContain('name="elsewhere"');
    expect(body).not.toContain('name="only_here"');
  });

  it("refuses an address no form on the page posts to", async () => {
    const browser = new TestBrowser();
    browser.currentHtml = arrows(pressable);

    await expect(browser.submitFormAt("/rows/3/move-up")).rejects.toThrow(
      'No form on this page posts to "/rows/3/move-up"',
    );
  });
});
