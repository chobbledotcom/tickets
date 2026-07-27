import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { addressFormSpec, oneIn } from "#test-utils/address-lookup-dom.ts";
import { installFakeDom, restoreDocument } from "#test-utils/fake-dom.ts";

describe("address-lookup DOM fixtures", () => {
  afterEach(() => {
    restoreDocument();
  });

  test("the form holds the panel, the textarea, and anything extra", () => {
    const [form] = installFakeDom([
      addressFormSpec([{ name: "lat", tag: "input", type: "text" }]),
    ]);
    const one = oneIn(form!);

    expect(one("[data-address-lookup]").tag).toBe("div");
    expect(one("textarea").tag).toBe("textarea");
    expect(one('[name="lat"]').tag).toBe("input");
  });

  test("looking up something the form does not have says which selector", () => {
    const [form] = installFakeDom([addressFormSpec()]);

    // A silent undefined would surface far from the missing element, so the
    // lookup names what it could not find.
    expect(() => oneIn(form!)('[name="lat"]')).toThrow(
      'No [name="lat"] in the address-lookup form',
    );
  });
});
