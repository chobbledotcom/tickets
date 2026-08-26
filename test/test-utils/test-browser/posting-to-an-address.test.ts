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
      <form action="/one" method="POST"><input name="only_here" value="1">
        <button type="submit">Save</button></form>
      <form action="/two" method="POST"><input name="elsewhere" value="2">
        <button type="submit">Publish</button></form>
    `;

    const body = browser.formBodyFor("Publish");

    expect(body).toContain('name="elsewhere"');
    expect(body).not.toContain('name="only_here"');
  });

  it("gives back only the body of the form that posts to an address", () => {
    const browser = new TestBrowser();
    browser.currentHtml = arrows(pressable);

    const body = browser.formBodyAt(SECOND_ROW);

    // The second row's own hidden field, and not the first row's, so a caller
    // checking what it may fill in is held to that one form.
    expect(body).toContain('value="tok2"');
    expect(body).not.toContain('value="tok"><');
  });

  describe("what one box of that form would really send", () => {
    /** A page whose select renders every choice but marks one, the shape that
     * makes reading the raw HTML useless: the unchosen names are all there. */
    const withChosen = (chosen: string) => {
      const browser = new TestBrowser();
      const option = (value: string) =>
        `<option${value === chosen ? " selected" : ""} value="${value}">${value}</option>`;
      browser.currentHtml = `
        <form action="${SECOND_ROW}" method="POST">
          <select name="provider">${["", "resend", "postmark"].map(option).join("")}</select>
          <input name="csrf" value="tok2">
          ${pressable}
        </form>
      `;
      return browser;
    };

    it("gives back the option a browser would submit, not every option", () => {
      expect(withChosen("postmark").wouldSendAt(SECOND_ROW, "provider")).toBe(
        "postmark",
      );
    });

    it("gives back the first choice when the page marks none", () => {
      // What a browser really sends for a select with nothing selected, so a
      // page that forgot to mark the stored choice reads as the empty one.
      expect(
        withChosen("none of them").wouldSendAt(SECOND_ROW, "provider"),
      ).toBe("");
    });

    it("gives back null for a box that form does not offer", () => {
      expect(withChosen("resend").wouldSendAt(SECOND_ROW, "elsewhere")).toBe(
        null,
      );
    });
  });

  it("refuses to read a form nobody could send, in the same words", async () => {
    const browser = new TestBrowser();
    browser.currentHtml = arrows('<button disabled type="submit">▲</button>');

    // Reading the form and sending it refuse alike, so a caller that reads
    // first is told what is wrong with the page rather than that a form is
    // missing when it is really switched off.
    expect(() => browser.formBodyAt(SECOND_ROW)).toThrow(NOTHING_TO_PRESS);
    await expect(browser.submitFormAt(SECOND_ROW)).rejects.toThrow(
      NOTHING_TO_PRESS,
    );
  });

  it("refuses an address no form on the page posts to", async () => {
    const browser = new TestBrowser();
    browser.currentHtml = arrows(pressable);

    await expect(browser.submitFormAt("/rows/3/move-up")).rejects.toThrow(
      'No form on this page posts to "/rows/3/move-up"',
    );
  });

  /**
   * Asking whether a page offers a way somewhere, rather than being told after
   * trying. A page can render a button for an action and still offer nobody a
   * way to take it, which is what a disabled Send button is.
   */
  describe("asking whether the page offers a way there at all", () => {
    const offersAWayTo = (secondArrow: string): boolean => {
      const browser = new TestBrowser();
      browser.currentHtml = arrows(secondArrow);
      return browser.offersAWayToPost(SECOND_ROW);
    };

    it("says yes when a button really posts there", () => {
      expect(offersAWayTo(pressable)).toBe(true);
    });

    it("says no when the only button there is switched off", () => {
      expect(offersAWayTo('<button disabled type="submit">▲</button>')).toBe(
        false,
      );
    });

    it("says no when the only button there sends nothing", () => {
      expect(offersAWayTo('<button type="button">▲</button>')).toBe(false);
    });

    it("says no for an address no form on the page posts to", () => {
      const browser = new TestBrowser();
      browser.currentHtml = arrows(pressable);

      expect(browser.offersAWayToPost("/rows/3/move-up")).toBe(false);
    });
  });
});
