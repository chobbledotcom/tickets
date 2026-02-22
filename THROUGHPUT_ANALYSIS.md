# Ticket System Throughput Analysis

An investigation into the throughput characteristics and bottlenecks of this ticket reservation system, with particular focus on the production deployment using libSQL on Bunny Database.

## Executive Summary

The system can comfortably handle **hundreds of ticket sales per hour** in its current form. Reaching **thousands per hour** is achievable but depends on the mix of free vs. paid events and whether webhooks are configured. The primary constraints are:

1. **Bunny Database single-writer model** (inherited from SQLite)
2. **Per-registration encryption overhead** (11 crypto operations per attendee)
3. **Synchronous webhook delivery** blocking request completion
4. **Network round-trip latency** to the remote database (~20-100ms per write)

## Architecture of the Write Path

### Free Event Registration

```
POST /ticket/:slug
  -> CSRF + form validation (CPU only, fast)
  -> encryptAttendeeFields()            [11 crypto ops]
  -> INSERT INTO attendees ... WHERE ... [1 DB write, atomic capacity check]
  -> logActivity()                       [1 DB write, with encryption]
  -> sendRegistrationWebhooks()          [0-N HTTP calls, BLOCKING]
  -> redirect
```

### Paid Event Registration

```
POST /ticket/:slug
  -> CSRF + form validation
  -> Stripe checkout session creation    [1 Stripe API call]
  -> redirect to Stripe

[After payment...]
POST /payment/webhook  OR  GET /payment/success
  -> Stripe session retrieval            [1 Stripe API call]
  -> reserveSession()                    [1 DB write]
  -> validateAndPrice()                  [1 DB read]
  -> encryptAttendeeFields()             [11 crypto ops]
  -> INSERT INTO attendees               [1 DB write, atomic capacity check]
  -> finalizeSession()                   [1 DB write]
  -> logActivity()                       [1 DB write, with encryption]
  -> sendRegistrationWebhooks()          [0-N HTTP calls, BLOCKING]
```

## Bottleneck Analysis

### 1. Bunny Database Write Throughput (Primary Constraint)

Bunny Database is SQLite-compatible via libSQL and uses a **single-writer model**:

- One writer at a time per database - all writes are serialized
- Read replicas across 41 regions proxy writes back to the primary
- Write latency is **20-100ms** depending on distance to primary region

**What this means in practice:**

| Scenario | DB writes per sale | Time per sale (DB only) | Max throughput |
|----------|-------------------|------------------------|----------------|
| Free event | 2 writes | ~40-200ms | ~1,800-5,000/hr |
| Paid event | 4 writes | ~80-400ms | ~900-2,500/hr |

These are theoretical maximums assuming writes are the only bottleneck and they arrive perfectly serialized. Real-world throughput will be lower due to the other factors below.

**Key architectural detail:** The atomic capacity check (`createAttendeeAtomic` at `src/lib/db/attendees.ts:382`) combines the availability check and insert into a single SQL statement using `INSERT ... SELECT ... WHERE`. This is the correct approach for SQLite's single-writer model - it avoids TOCTOU race conditions without needing explicit transactions.

### 2. Encryption Overhead (Per-Registration CPU Cost)

Every attendee creation requires **11 hybrid encryption operations** (`src/lib/db/attendees.ts:176-201`):

- 9 fields use RSA+AES hybrid encryption (name, email, phone, address, special_instructions, payment_id, checked_in, refunded, ticket_token)
- 1 field uses AES-GCM symmetric encryption (price_paid)
- 1 HMAC computation (ticket_token_index)

Each hybrid encryption (`src/lib/crypto.ts:678-707`) involves:
1. Generate random AES-256 key
2. Encrypt data with AES-GCM
3. Export AES key
4. Encrypt AES key with RSA-OAEP (2048-bit)

On Bunny Edge Scripting (V8 isolate), RSA operations are the most expensive. Estimated per-registration encryption time: **5-20ms** on edge, depending on CPU allocation.

The activity log write also requires 1 additional AES encryption for the log message.

**Assessment:** Encryption is not the primary bottleneck but adds meaningful overhead. The fields encrypted per attendee are generous - boolean fields like `checked_in` and `refunded` are hybrid-encrypted despite being non-sensitive.

### 3. Synchronous Webhook Delivery (Latency Amplifier)

Webhook sending (`src/lib/webhook.ts:128-143`) is **synchronous and sequential**:

```typescript
for (const url of webhookUrls) {
  await sendWebhook(url, payload);  // Blocks until response
}
```

If a webhook endpoint responds in 500ms and you have 2 webhook URLs (per-event + global), that's **1 second added** to every registration. During that second, the Edge Scripting worker is occupied and cannot process other requests.

This is the most impactful bottleneck for user-perceived latency, though it doesn't directly limit database throughput (other requests can still write while one waits on webhooks).

### 4. Stripe API Calls (Paid Events Only)

Paid events involve:
- **Checkout session creation** (during initial POST): ~200-500ms Stripe API call
- **Session retrieval** (during webhook/redirect): ~200-500ms Stripe API call
- Potential **refund creation** if capacity exceeded post-payment

Stripe rate limits: 100 read operations/sec, 100 write operations/sec in live mode. At 100 checkout sessions/sec you'd hit Stripe's limit, which translates to **360,000/hour** - well above any database bottleneck.

### 5. Edge Scripting Concurrency

Bunny Edge Scripting runs V8 isolates. Key considerations:
- Each request runs in its own isolate context
- The libSQL client uses HTTP transport to Bunny Database (not a persistent connection)
- No connection pooling concerns - each request makes independent HTTP calls to the database
- Multiple concurrent requests can execute, but all writes serialize at the database level

## Realistic Throughput Estimates

### Scenario: Free event, no webhooks configured

- Per-sale cost: ~15ms encryption + ~50-100ms DB writes (2 writes)
- Effective serial throughput: ~3,600-5,000 sales/hour
- With concurrent requests (writes serialize, encryption parallelizes): ~3,600-5,000/hr

### Scenario: Free event, 1 webhook configured

- Per-sale cost: ~15ms encryption + ~50-100ms DB + ~200-1000ms webhook
- User-perceived latency: 265-1,115ms per sale
- DB throughput unchanged, but Edge worker occupancy increases
- Effective throughput depends on Edge Scripting concurrency limits

### Scenario: Paid event, 1 webhook

- Per-sale cost: ~200-500ms Stripe + ~15ms encryption + ~100-400ms DB (4 writes) + ~200-1000ms webhook
- Most of this is network-bound and can overlap across requests
- DB bottleneck: ~900-2,500/hr (limited by 4 serial writes per sale)

### Scenario: High-concurrency burst (e.g., concert tickets on sale at noon)

This is where the single-writer model matters most. If 500 people submit at the same second:
- All 500 requests hit the edge concurrently
- Encryption runs in parallel across isolates
- All writes queue at the single database writer
- At ~50-100ms per write pair, the 500th request waits ~25-50 seconds for its turn
- Some requests will likely time out

## Comparison: "Thousands per hour"

| Target | Required throughput | Achievable? |
|--------|-------------------|-------------|
| 1,000/hour | ~17/min, ~0.3/sec | Yes, comfortably |
| 5,000/hour | ~83/min, ~1.4/sec | Yes, for free events without webhooks |
| 10,000/hour | ~167/min, ~2.8/sec | Marginal, depends on write latency |
| 50,000/hour | ~833/min, ~14/sec | No, without architectural changes |

## Recommendations for Scaling

### Quick wins (no architectural changes)

1. **Fire-and-forget webhooks**: Don't `await` webhook responses. The webhook send already catches errors silently - there's no reason to block the user response on it.

2. **Batch the activity log write with the attendee insert**: Currently these are 2 separate DB round-trips. If libSQL's batch API supports writes, combining them into a single batch would halve the per-sale DB round-trips for free events.

3. **Reduce encryption operations**: `checked_in` and `refunded` are always inserted as `"false"` - consider storing these as plaintext booleans since they're not PII. This saves 2 RSA hybrid encryptions per registration.

### Medium-term improvements

4. **Write-behind queue for non-critical writes**: Activity log entries don't need to be synchronous. Queue them and flush periodically.

5. **Pre-compute encrypted "false" values**: Since `checked_in` and `refunded` always start as `"false"`, encrypt once at startup and reuse. (Though with hybrid encryption, each ciphertext must be unique due to the random AES key - so this would require switching these fields to a different encryption scheme.)

### Architectural changes for high scale

6. **Database-per-event or sharding**: Bunny Database allows 50 databases per account. For truly high-demand events, a dedicated database removes write contention with other events.

7. **Reservation queue pattern**: Instead of synchronous insert-or-reject, accept reservations into a queue and process them sequentially. This improves user experience during bursts (everyone gets "processing..." instead of timeouts) but doesn't increase actual throughput.

8. **Move to a different database**: If write throughput becomes the limiting factor, PostgreSQL or MySQL would remove the single-writer constraint. Bunny's Magic Containers could host a PostgreSQL instance, though you'd lose the serverless spin-down-when-idle pricing model.

## Key Code References

| Component | File | Line |
|-----------|------|------|
| Atomic attendee creation | `src/lib/db/attendees.ts` | 349-435 |
| Encryption per attendee | `src/lib/db/attendees.ts` | 176-201 |
| Hybrid encryption (RSA+AES) | `src/lib/crypto.ts` | 678-707 |
| Webhook delivery (synchronous) | `src/lib/webhook.ts` | 128-143 |
| Payment session processing | `src/routes/webhooks.ts` | 447-507 |
| Two-phase payment locking | `src/lib/db/processed-payments.ts` | 108-141 |
| DB client (single instance) | `src/lib/db/client.ts` | 14-31 |
| Activity log (encrypted write) | `src/lib/db/activityLog.ts` | 49-53 |

## Sources

- [Bunny Database HN discussion](https://news.ycombinator.com/item?id=46870015) - Bunny confirms single-writer model
- [Turso: Beyond the Single-Writer Limitation](https://turso.tech/blog/beyond-the-single-writer-limitation-with-tursos-concurrent-writes) - libSQL concurrent write benchmarks
- [SQLite WAL documentation](https://sqlite.org/wal.html) - Write-Ahead Logging concurrency model
- [SQLite concurrent writes analysis](https://oldmoe.blog/2024/07/08/the-write-stuff-concurrent-write-transactions-in-sqlite/) - Single-writer throughput benchmarks
- [Bunny Database product page](https://bunny.net/database/) - Pricing and architecture overview
