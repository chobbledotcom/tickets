/** Direct tests for the after-pay watch loop. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  type AfterPayClock,
  type AfterPayProbes,
  watchAfterPay,
} from "#e2e/providers/post-pay.ts";

/** A clock that only moves when the loop waits, so no test sleeps for real. */
const scriptedClock = (): AfterPayClock & { waits: number[] } => {
  const waits: number[] = [];
  let time = 0;
  return {
    now: () => time,
    wait: (ms) => {
      waits.push(ms);
      time += ms;
      return Promise.resolve();
    },
    waits,
  };
};

/** Probes that answer from scripted lists. A probe asked past the end of its
 * script answers "nothing changed" — off-script is a fact of the fake, not a
 * suppressed failure. */
const scriptedProbes = (script: {
  back?: boolean[];
  decline?: boolean[];
  onProvider?: boolean[];
}): AfterPayProbes & { asks: { back: number; decline: number } } => {
  const asks = { back: 0, decline: 0 };
  let onProviderAsks = 0;
  return {
    asks,
    clickBack: () => {
      const answer = script.back?.[asks.back] ?? false;
      asks.back += 1;
      return Promise.resolve(answer);
    },
    declineVisible: () => {
      const answer = script.decline?.[asks.decline] ?? false;
      asks.decline += 1;
      return Promise.resolve(answer);
    },
    onProvider: () => {
      const answer = script.onProvider?.[onProviderAsks] ?? true;
      onProviderAsks += 1;
      return answer;
    },
  };
};

describe("watching the page after Pay", () => {
  it("reports left_provider as soon as the browser is off the provider", async () => {
    const clock = scriptedClock();
    const probes = scriptedProbes({ onProvider: [false] });
    expect(await watchAfterPay(probes, clock, 30_000)).toBe("left_provider");
    expect(probes.asks.decline).toBe(0);
    expect(clock.waits).toEqual([]);
  });

  it("reports declined without asking for the back control", async () => {
    const clock = scriptedClock();
    const probes = scriptedProbes({ decline: [true] });
    expect(await watchAfterPay(probes, clock, 30_000)).toBe("declined");
    expect(probes.asks.back).toBe(0);
  });

  it("reports clicked_back when the back control was clicked", async () => {
    const clock = scriptedClock();
    const probes = scriptedProbes({ back: [true] });
    expect(await watchAfterPay(probes, clock, 30_000)).toBe("clicked_back");
    expect(clock.waits).toEqual([]);
  });

  it("waits between asks until the back control appears", async () => {
    const clock = scriptedClock();
    const probes = scriptedProbes({ back: [false, false, true] });
    expect(await watchAfterPay(probes, clock, 30_000)).toBe("clicked_back");
    expect(clock.waits).toEqual([500, 500]);
  });

  it("reports a decline that only appears on a later ask", async () => {
    const clock = scriptedClock();
    const probes = scriptedProbes({ decline: [false, false, true] });
    expect(await watchAfterPay(probes, clock, 30_000)).toBe("declined");
    expect(probes.asks.back).toBe(2);
  });

  it("times out when nothing happens before the deadline", async () => {
    const clock = scriptedClock();
    const probes = scriptedProbes({});
    expect(await watchAfterPay(probes, clock, 1_500)).toBe("timed_out");
    expect(clock.waits).toEqual([500, 500, 500]);
    expect(clock.now()).toBe(1_500);
  });

  it("never waits past a deadline that is not a multiple of the poll step", async () => {
    const clock = scriptedClock();
    const probes = scriptedProbes({});
    expect(await watchAfterPay(probes, clock, 750)).toBe("timed_out");
    expect(clock.waits).toEqual([500, 250]);
    expect(clock.now()).toBe(750);
  });

  it("times out at once on a zero deadline, with no asks", async () => {
    const clock = scriptedClock();
    const probes = scriptedProbes({});
    expect(await watchAfterPay(probes, clock, 0)).toBe("timed_out");
    expect(probes.asks.decline).toBe(0);
    expect(clock.waits).toEqual([]);
  });
});
