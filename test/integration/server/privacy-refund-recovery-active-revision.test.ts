/** A stale owner check cannot act on a newer active refund revision. */

import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { loadRefundAuthorityById } from "#db/provider-refund-authority.ts";
import { transitionRefundAuthority } from "#db/provider-refund-authority-change.ts";
import { armRefundSend } from "#payment/refund-authority.ts";
import { refundRequestIdentityIndex } from "#payment/refund-request-identity.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  addProviderRefundTestCase,
  readyRefundTestState,
} from "#test-utils/provider-refund-cases.ts";
import { adminGet } from "#test-utils/session.ts";
import {
  expectStaleProviderCheckRefused,
  refundCasePath,
} from "./privacy-refund-recovery-helpers.ts";

describeWithEnv("owner active refund revision fence", { db: true }, () => {
  test("a stale provider-check form stops before any provider call", async () => {
    const rawReference = "owner-stale-active-reference";
    const identity = await refundRequestIdentityIndex(
      { kind: "tagged", provider: "sumup", reference: rawReference },
      1,
    );
    const id = await addProviderRefundTestCase(
      rawReference,
      readyRefundTestState(identity),
    );
    const rendered = await adminGet(refundCasePath(id));
    expect(await rendered.text()).toContain(
      'name="revision" type="hidden" value="1"',
    );

    const ready = await loadRefundAuthorityById(id);
    assert(ready !== null);
    expect(ready.state.kind).toBe("ready");
    const armed = await transitionRefundAuthority(
      ready,
      12,
      ready.refunded,
      (state) => armRefundSend(state, 11, 20),
    );
    assert(armed !== null);
    expect(armed.revision).toBe(2);
    expect(armed.state.kind).toBe("send_armed");

    await expectStaleProviderCheckRefused(id, armed, () =>
      loadRefundAuthorityById(id),
    );
  });
});
