import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  CapacityMeter,
  capacityLevel,
  capacityMeterText,
  GroupCapacityMeter,
} from "#templates/components/capacity.tsx";

describe("capacityLevel", () => {
  test("is calm below 90% of the cap", () => {
    expect(capacityLevel(8, 10)).toEqual({
      nearLimit: false,
      overLimit: false,
      remaining: 2,
    });
  });

  test("warns exactly at 90% of the cap", () => {
    expect(capacityLevel(9, 10)).toEqual({
      nearLimit: true,
      overLimit: false,
      remaining: 1,
    });
  });

  test("warns between 90% and the cap", () => {
    expect(capacityLevel(19, 20)).toEqual({
      nearLimit: true,
      overLimit: false,
      remaining: 1,
    });
  });

  test("is over exactly at the cap", () => {
    expect(capacityLevel(10, 10)).toEqual({
      nearLimit: true,
      overLimit: true,
      remaining: 0,
    });
  });

  test("applies both limits to a cap of one", () => {
    expect(capacityLevel(1, 1)).toEqual({
      nearLimit: true,
      overLimit: true,
      remaining: 0,
    });
  });

  test("reports negative seats left past the cap", () => {
    expect(capacityLevel(12, 10)).toEqual({
      nearLimit: true,
      overLimit: true,
      remaining: -2,
    });
  });

  test("treats a zero cap as no cap at all", () => {
    expect(capacityLevel(100, 0)).toEqual({
      nearLimit: false,
      overLimit: false,
      remaining: -100,
    });
  });
});

describe("capacityMeterText", () => {
  test("formats count, cap, and seats left", () => {
    expect(capacityMeterText(12, 20)).toBe("12 / 20 — 8 remain");
  });

  test("shows an overridden seats-left figure", () => {
    expect(capacityMeterText(12, 10, 0)).toBe("12 / 10 — 0 remain");
  });
});

describe("CapacityMeter", () => {
  test("renders a span with an empty class when calm", () => {
    const html = String(<CapacityMeter count={5} danger={false} max={20} />);
    expect(html).toBe('<span class="">5 / 20 — 15 remain</span>');
  });

  test("renders a danger span when the warning flag is on", () => {
    const html = String(<CapacityMeter count={19} danger={true} max={20} />);
    expect(html).toBe('<span class="danger-text">19 / 20 — 1 remain</span>');
  });

  test("shows an overridden seats-left figure", () => {
    const html = String(
      <CapacityMeter count={12} danger={true} max={10} remaining={0} />,
    );
    expect(html).toBe('<span class="danger-text">12 / 10 — 0 remain</span>');
  });
});

describe("GroupCapacityMeter", () => {
  test("is calm below 90% of the group cap", () => {
    const html = String(<GroupCapacityMeter count={20} max={50} />);
    expect(html).toBe('<span class="">20 / 50 — 30 remain</span>');
  });

  test("warns from 90% of the group cap", () => {
    const html = String(<GroupCapacityMeter count={9} max={10} />);
    expect(html).toBe('<span class="danger-text">9 / 10 — 1 remain</span>');
  });

  test("never shows fewer than zero seats left", () => {
    const html = String(<GroupCapacityMeter count={12} max={10} />);
    expect(html).toBe('<span class="danger-text">12 / 10 — 0 remain</span>');
  });
});
