import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import {
  resetEffectiveDomain,
  setEffectiveDomainForTest,
} from "#shared/config.ts";
import { buildCheckinUrl, buildTicketUrl } from "#shared/ticket-url.ts";

const DOMAIN = "tickets.example.com";
const entry = (ticket_token: string) => ({ attendee: { ticket_token } });

describe("buildTicketUrl", () => {
  beforeEach(() => setEffectiveDomainForTest(DOMAIN));
  afterEach(() => resetEffectiveDomain());

  test("joins each attendee's token with '+' under the /t path", () => {
    expect(buildTicketUrl([entry("aaa"), entry("bbb"), entry("ccc")])).toBe(
      `https://${DOMAIN}/t/aaa+bbb+ccc`,
    );
  });

  test("renders a single token without any separator", () => {
    expect(buildTicketUrl([entry("solo")])).toBe(`https://${DOMAIN}/t/solo`);
  });

  test("de-duplicates repeated tokens, preserving first-seen order", () => {
    expect(
      buildTicketUrl([
        entry("a"),
        entry("b"),
        entry("a"),
        entry("c"),
        entry("b"),
      ]),
    ).toBe(`https://${DOMAIN}/t/a+b+c`);
  });

  test("produces a trailing /t/ with no tokens for an empty selection", () => {
    expect(buildTicketUrl([])).toBe(`https://${DOMAIN}/t/`);
  });

  test("uses the effective domain (falling back to localhost when unset)", () => {
    resetEffectiveDomain();
    expect(buildTicketUrl([entry("x")])).toBe("https://localhost/t/x");
  });
});

describe("buildCheckinUrl", () => {
  beforeEach(() => setEffectiveDomainForTest(DOMAIN));
  afterEach(() => resetEffectiveDomain());

  test("builds the single-token check-in URL under /checkin", () => {
    expect(buildCheckinUrl("tok123")).toBe(`https://${DOMAIN}/checkin/tok123`);
  });

  test("uses the effective domain (falling back to localhost when unset)", () => {
    resetEffectiveDomain();
    expect(buildCheckinUrl("tok123")).toBe("https://localhost/checkin/tok123");
  });
});
