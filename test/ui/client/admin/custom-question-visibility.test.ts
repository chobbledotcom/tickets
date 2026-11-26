import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { initQuestionVisibility } from "#src/ui/client/admin/custom-question-visibility.ts";
import {
  childQtySpec,
  childSelectorSpec,
  type ElementSpec,
  type FakeElement,
  installFakeDom,
  packageSelectorSpec,
  quantitySpec as quantity,
  restoreDocument,
  soleChildSpec,
} from "#test-utils/fake-dom.ts";

const question = (listingIds: string, control: ElementSpec): ElementSpec => ({
  children: [control],
  class: "custom-question",
  data: { listingIds },
  tag: "label",
});

const textControl = (): ElementSpec => ({
  required: false,
  tag: "input",
  type: "text",
});

const parentBlock = (parentId: string, childId: string): ElementSpec => ({
  ...childSelectorSpec(parentId),
  children: [childQtySpec(parentId, childId, "1")],
});

const findControl = (roots: FakeElement[], type: string): FakeElement =>
  roots.flatMap((root) => root.querySelectorAll(`input[type="${type}"]`))[0]!;

describe("custom question visibility", () => {
  afterEach(restoreDocument);

  test("does not attach change listeners when there are no scoped questions", () => {
    let listenerAttached = false;
    const roots = installFakeDom([quantity("101", "1")]);
    roots[0]!.addEventListener = () => {
      listenerAttached = true;
    };

    // No .custom-question elements -> initQuestionVisibility returns early and
    // never wires onSelectionChange to the quantity control.
    initQuestionVisibility();

    expect(listenerAttached).toBe(false);
  });

  const assertHiddenAndDeRequired = (
    roots: ReturnType<typeof installFakeDom>,
    text: { required: boolean },
  ): void => {
    expect(roots[0]!.hidden).toBe(true);
    expect(text.required).toBe(false);
  };

  /** A ticket field: one ticket of one line, with the control that the
   * line's quantity comes from. */
  const ticketField = (source: string, unit: number): ElementSpec => ({
    children: [textControl()],
    class: "custom-question",
    data: { source, unit: String(unit) },
    tag: "label",
  });

  /** Each place a line's quantity comes from, the page controls that give it
   * two tickets, and the source the field names. */
  const LINE_SOURCES: [string, string, ElementSpec[]][] = [
    ["its own quantity", "q:101", [quantity("101", "2")]],
    [
      "a package count times the member's fixed quantity",
      "p:3:2",
      [packageSelectorSpec(["101:2"], "1")],
    ],
    [
      "a child's quantity under one parent in the cart",
      "c:101:301",
      [
        quantity("101", "1"),
        childSelectorSpec("101"),
        childQtySpec("101", "301", "2"),
      ],
    ],
    [
      "a sole child, which takes all of its parent's tickets",
      "c:101:301",
      [quantity("101", "2"), soleChildSpec("101", "301")],
    ],
  ];

  for (const [name, source, controls] of LINE_SOURCES) {
    test(`a line that takes two tickets from ${name} shows and requires two fields, and hides and disables the third`, () => {
      const roots = installFakeDom([
        ...[0, 1, 2].map((unit) => ticketField(source, unit)),
        ...controls,
      ]);
      const texts = roots
        .slice(0, 3)
        .map((field) => field.querySelectorAll('input[type="text"]')[0]!);

      initQuestionVisibility();

      expect(roots.slice(0, 3).map((field) => field.hidden)).toEqual([
        false,
        false,
        true,
      ]);
      expect(
        texts.map(({ disabled, required }) => [disabled, required]),
      ).toEqual([
        [false, true],
        [false, true],
        [true, false],
      ]);
    });
  }

  test("a child's ticket field stays hidden, disabled and optional while its parent is not in the cart", () => {
    const roots = installFakeDom([
      ticketField("c:101:301", 0),
      quantity("101", "0"),
      childSelectorSpec("101"),
      childQtySpec("101", "301", "2"),
    ]);
    const text = roots[0]!.querySelectorAll('input[type="text"]')[0]!;

    initQuestionVisibility();

    expect([roots[0]!.hidden, text.disabled, text.required]).toEqual([
      true,
      true,
      false,
    ]);
  });

  test("hides and de-requires a question with no active listing", () => {
    const control = textControl();
    const roots = installFakeDom([
      question("101", control),
      quantity("101", "0"),
    ]);
    const text = findControl(roots, "text");

    initQuestionVisibility();

    assertHiddenAndDeRequired(roots, text);
  });

  test("shows and requires a question for a child given a positive quantity under an in-cart parent", () => {
    const control = textControl();
    const roots = installFakeDom([
      question("202", control), // 202 is the child listing id
      quantity("101", "2"), // parent in cart
      parentBlock("101", "202"), // child 202 chosen (qty 1)
    ]);
    const text = findControl(roots, "text");

    initQuestionVisibility();

    expect(roots[0]!.hidden).toBe(false);
    expect(text.required).toBe(true);
  });

  test("redistributing the quantity hides the first child's question and reveals the sibling's", () => {
    const firstQ = textControl();
    const siblingQ = textControl();
    const roots = installFakeDom([
      question("202", firstQ),
      question("303", siblingQ),
      quantity("101", "1"),
      childSelectorSpec("101"),
      childQtySpec("101", "202", "1"),
      childQtySpec("101", "303", "0"),
    ]);

    initQuestionVisibility();
    expect(roots[0]!.hidden).toBe(false); // 202 visible
    expect(roots[1]!.hidden).toBe(true); // 303 hidden

    // Buyer moves the unit from 202 to 303.
    const selectedA = roots[4]!;
    const selectedB = roots[5]!;
    selectedA.value = "0";
    selectedB.value = "1";
    selectedB.dispatch("change");

    expect(roots[0]!.hidden).toBe(true); // 202 now hidden
    expect(roots[1]!.hidden).toBe(false); // 303 now visible
  });

  test("both children's questions show when each is given a positive quantity", () => {
    const firstQ = textControl();
    const siblingQ = textControl();
    const roots = installFakeDom([
      question("202", firstQ),
      question("303", siblingQ),
      quantity("101", "2"),
      childSelectorSpec("101"),
      childQtySpec("101", "202", "1"),
      childQtySpec("101", "303", "1"),
    ]);

    initQuestionVisibility();
    // The per-unit model can pick one of each, so both questions are active.
    expect(roots[0]!.hidden).toBe(false);
    expect(roots[1]!.hidden).toBe(false);
  });

  test("a child-only question stays hidden when its parent is at zero quantity", () => {
    const control = textControl();
    const roots = installFakeDom([
      question("202", control),
      quantity("101", "0"), // parent not in cart
      parentBlock("101", "202"), // child chosen, but parent qty 0
    ]);
    const text = findControl(roots, "text");

    initQuestionVisibility();

    assertHiddenAndDeRequired(roots, text);
  });
});
