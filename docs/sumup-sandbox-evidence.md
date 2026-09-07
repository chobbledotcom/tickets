# SumUp sandbox evidence

Evidence collected on 2026-08-05 with `@sumup/sdk` 0.1.6, and reviewed as
sanitized deterministic fixtures under `test/fixtures/sumup/sandbox/`. The
fixture-only review found no credential, original provider value, URL,
instrument/auth data, metadata, or PII leak, and confirmed linked identities and
endpoint labels.

This document preserves the observed wire facts. The enforced shapes live in
`src/shared/sumup-observation.ts` and its test
(`test/shared/sumup-observation.test.ts`), which reads the tables below.

| State             | `GET /v0.1/checkouts/{checkout_id}` observed fields                                                                                                                                                            |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pending           | `id`, `checkout_reference`, `amount`, `currency`, `merchant_code`, `status: "PENDING"`, and `transactions: []`; `transaction_id` omitted                                                                       |
| Paid              | The same top-level identity/money/merchant fields with `status: "PAID"`; `transaction_id` present; exactly one `transactions[]` entry with the same ID, amount, currency, `status: "SUCCESSFUL"`, and merchant |
| Failed            | The same top-level identity/money/merchant fields with `status: "FAILED"`; exactly one failed transaction with ID, amount, currency, `status: "FAILED"`, and merchant; `transaction_id` omitted                |
| After full refund | Checkout remains `status: "PAID"`; its named transaction remains `status: "SUCCESSFUL"`. Checkout retrieval does not expose refund completion                                                                  |

The full refund was proved by the documented authoritative
`GET /v2.1/merchants/{merchant_code}/transactions?id={transaction_id}` response:
`transaction_events[]` contained a `REFUND` event with `status: "REFUNDED"` and
amount equal to the original transaction amount. The transaction's top-level
`status` and `simple_status` both remained `"SUCCESSFUL"`; neither is refund
authority for this observed sandbox response. Transaction history independently
corroborated the same full amount through the payment item's `refunded_amount`
and a linked refund item, but production needs no history read because the exact
transaction response already proves the full refund.

One authenticated `GET /v1/merchants/{merchant_code}` returned the configured
merchant code and `sandbox: true`; the restricted key had no mode prefix
recognized by `keyModeOf`. Sandbox identity for restricted keys comes from the
matching Merchant response, never a key-prefix assumption. Exact status-specific
field presence comes from the evidence above, not an assumption.

Schema note from the same collection: narrow schemas that promise rejection of
unknown properties use `v.strictObject`; ordinary `v.object` strips extras and
must not be described as rejecting them. Provider wire schemas and request-local
ownership schemas are different boundaries and must not be conflated.
