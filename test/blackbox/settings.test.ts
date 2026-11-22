import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  boxText,
  boxTicked,
  inputsNamed,
  redirectOf,
} from "#test/blackbox/settings.ts";

const answer = (location: string | null) => ({
  headers: new Headers(),
  html: "",
  location,
  status: 302,
});

test("a save redirect gives the address that it names", () => {
  expect(redirectOf(answer("/admin/settings"))).toBe("/admin/settings");
});

test("a save redirect that names no address fails loudly", () => {
  expect(() => redirectOf(answer(null))).toThrow("The save named no address.");
});

test("the text of a box reads a textarea, without the first newline", () => {
  const html = '<textarea name="terms" rows="3">\nA &amp; B\n</textarea>';
  expect(boxText(html, "terms")).toBe("A & B\n");
});

test("the text of a box reads the value of an input, or nothing without one", () => {
  expect(boxText('<input name="fee" value="1 &lt; 2">', "fee")).toBe("1 < 2");
  expect(boxText('<input name="fee" type="text">', "fee")).toBe("");
});

test("the text of a box that the page does not show fails loudly", () => {
  expect(() => boxText('<input name="other" value="x">', "fee")).toThrow(
    'The page shows no box "fee".',
  );
});

test("the inputs with a name leave the other inputs out", () => {
  const named = '<input name="on" type="checkbox">';
  expect(inputsNamed(`${named}<input name="off">`, "on")).toEqual([named]);
  expect(inputsNamed("<p>no inputs</p>", "on")).toEqual([]);
});

test("a ticked box reads as ticked, and a box with no tick does not", () => {
  expect(boxTicked('<input checked name="on" value="true">', "on")).toBe(true);
  expect(boxTicked('<input name="on" value="true">', "on")).toBe(false);
});

test("a page with no box, or with two, fails loudly", () => {
  const message = 'The page does not show one box for "on".';
  expect(() => boxTicked("<p>none</p>", "on")).toThrow(message);
  expect(() =>
    boxTicked('<input name="on"><input checked name="on">', "on"),
  ).toThrow(message);
});
