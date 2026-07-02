import { expect } from "@std/expect";
import { describe } from "@std/testing/bdd";
import {
  moneyPattern,
  moneyStep,
  PriceInput,
} from "#templates/components/price-input.tsx";
import { testWithSetting } from "#test-utils";

describe("moneyStep", () => {
  testWithSetting(
    "is 0.01 for a 2-decimal currency (GBP)",
    { currency: "GBP" },
    () => {
      expect(moneyStep()).toBe("0.01");
    },
  );

  testWithSetting(
    "is 1 for a zero-decimal currency (JPY)",
    { currency: "JPY" },
    () => {
      expect(moneyStep()).toBe("1");
    },
  );

  testWithSetting(
    "is 0.001 for a 3-decimal currency (KWD)",
    { currency: "KWD" },
    () => {
      expect(moneyStep()).toBe("0.001");
    },
  );
});

describe("moneyPattern", () => {
  testWithSetting(
    "allows up to N decimals for an N-decimal currency (GBP)",
    { currency: "GBP" },
    () => {
      expect(moneyPattern()).toBe("\\d+(\\.\\d{1,2})?");
    },
  );

  testWithSetting(
    "allows no decimals for a zero-decimal currency (JPY)",
    { currency: "JPY" },
    () => {
      expect(moneyPattern()).toBe("\\d+");
    },
  );

  testWithSetting(
    "allows up to 3 decimals for a 3-decimal currency (KWD)",
    { currency: "KWD" },
    () => {
      expect(moneyPattern()).toBe("\\d+(\\.\\d{1,3})?");
    },
  );
});

describe("PriceInput", () => {
  testWithSetting(
    "renders a currency-aware number input carrying its optional attrs",
    { currency: "KWD" },
    () => {
      const html = String(
        PriceInput({ min: "0", name: "amount", value: "1.005" }),
      );
      expect(html).toContain('name="amount"');
      expect(html).toContain('type="number"');
      expect(html).toContain('inputmode="decimal"');
      // step tracks the 3-decimal currency, so 1.005 is typeable.
      expect(html).toContain('step="0.001"');
      expect(html).toContain('min="0"');
      expect(html).toContain('value="1.005"');
    },
  );

  testWithSetting(
    "omits min/value when not given and marks required",
    { currency: "GBP" },
    () => {
      const html = String(PriceInput({ name: "amount", required: true }));
      expect(html).toContain('step="0.01"');
      expect(html).toContain(" required");
      expect(html).not.toContain("min=");
      expect(html).not.toContain("value=");
    },
  );
});
