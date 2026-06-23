import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { initQuestionVisibility } from "#src/ui/client/admin/custom-question-visibility.ts";
import {
  childRadioSpec,
  childSelectorSpec,
  type ElementSpec,
  type FakeElement,
  installFakeDom,
  quantitySpec as quantity,
  restoreDocument,
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
  children: [childRadioSpec(parentId, childId, true)],
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

  test("hides and de-requires a question with no active listing", () => {
    const control = textControl();
    const roots = installFakeDom([
      question("101", control),
      quantity("101", "0"),
    ]);
    const text = findControl(roots, "text");

    initQuestionVisibility();

    expect(roots[0]!.hidden).toBe(true);
    expect(text.required).toBe(false);
  });

  test("shows and requires a question for a child selected under an in-cart parent", () => {
    const control = textControl();
    const roots = installFakeDom([
      question("202", control), // 202 is the child listing id
      quantity("101", "2"), // parent in cart
      parentBlock("101", "202"), // child 202 selected
    ]);
    const text = findControl(roots, "text");

    initQuestionVisibility();

    expect(roots[0]!.hidden).toBe(false);
    expect(text.required).toBe(true);
  });

  test("switching to a sibling hides the first child's question and reveals the sibling's", () => {
    const firstQ = textControl();
    const siblingQ = textControl();
    const roots = installFakeDom([
      question("202", firstQ),
      question("303", siblingQ),
      quantity("101", "1"),
      childSelectorSpec("101"),
      childRadioSpec("101", "202", true),
      childRadioSpec("101", "303", false),
    ]);

    initQuestionVisibility();
    expect(roots[0]!.hidden).toBe(false); // 202 visible
    expect(roots[1]!.hidden).toBe(true); // 303 hidden

    // Buyer switches to the sibling child.
    const selectedA = roots[4]!;
    const selectedB = roots[5]!;
    selectedA.checked = false;
    selectedB.checked = true;
    selectedB.dispatch("change");

    expect(roots[0]!.hidden).toBe(true); // 202 now hidden
    expect(roots[1]!.hidden).toBe(false); // 303 now visible
  });

  test("a child-only question stays hidden when its parent is at zero quantity", () => {
    const control = textControl();
    const roots = installFakeDom([
      question("202", control),
      quantity("101", "0"), // parent not in cart
      parentBlock("101", "202"), // child auto-selected, but parent qty 0
    ]);
    const text = findControl(roots, "text");

    initQuestionVisibility();

    expect(roots[0]!.hidden).toBe(true);
    expect(text.required).toBe(false);
  });
});
