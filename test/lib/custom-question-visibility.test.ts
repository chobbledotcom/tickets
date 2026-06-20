import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { initQuestionVisibility } from "#src/ui/client/admin/custom-question-visibility.ts";

type FakeControl = { required: boolean };
type FakeField = {
  dataset: { listingIds: string };
  hidden: boolean;
  querySelectorAll: (selector: string) => FakeControl[];
};
type FakeQuantity = {
  value: string;
  addEventListener: (event: string, listener: () => void) => void;
};

const originalDocument = globalThis.document;

const setDocument = (
  field: FakeField | null,
  quantity: FakeQuantity | null,
): void => {
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      querySelector: (selector: string) =>
        selector === '[name="quantity_101"]' ? quantity : null,
      querySelectorAll: (selector: string) =>
        selector === ".custom-question[data-listing-ids]"
          ? field === null
            ? []
            : [field]
          : selector === '[name^="quantity_"]'
            ? quantity === null
              ? []
              : [quantity]
            : [],
    } as unknown as Document,
  });
};

describe("custom question visibility", () => {
  afterEach(() => {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: originalDocument,
    });
  });

  test("does not attach quantity listeners when there are no scoped questions", () => {
    let listenerAttached = false;
    const quantity: FakeQuantity = {
      addEventListener: () => {
        listenerAttached = true;
      },
      value: "1",
    };
    setDocument(null, quantity);

    initQuestionVisibility();

    expect(listenerAttached).toBe(false);
  });

  test("drops required from hidden free-text controls", () => {
    const textInput = { required: true };
    const field: FakeField = {
      dataset: { listingIds: "101" },
      hidden: false,
      querySelectorAll: () => [textInput],
    };
    const quantity: FakeQuantity = {
      addEventListener: () => {},
      value: "0",
    };
    setDocument(field, quantity);

    initQuestionVisibility();

    expect(field.hidden).toBe(true);
    expect(textInput.required).toBe(false);
  });
});
