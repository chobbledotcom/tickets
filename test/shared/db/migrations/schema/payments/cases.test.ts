import { it as test } from "@std/testing/bdd";
import { describeWithEnv } from "#test-utils/db.ts";
import { expectRefused } from "./refuses.ts";

describeWithEnv("db > payment case rules", { db: true }, () => {
  test("refuses a case alerted before the problem was first seen", async () => {
    await expectRefused(`INSERT INTO payment_cases
      (payment_id, resource, resource_index, reason, state,
       first_observed_at, last_observed_at, consecutive_count, evidence,
       revision, alerted_at, alerted_revision)
      VALUES ('early-alert', 'enc:1:a:b', 'early-alert-index', 'network_error',
        'needs_action', 100, 100, 1, 'enc:1:a:b', 1, 1, 1)`);
  });

  test("refuses case alert bookkeeping that is not a real time or revision", async () => {
    await expectRefused(`INSERT INTO payment_cases
      (payment_id, resource, resource_index, reason, state,
       first_observed_at, last_observed_at, consecutive_count, evidence,
       revision, alerted_at, alerted_revision)
      VALUES ('bad-alert', 'enc:1:a:b', 'bad-alert-index', 'network_error',
        'needs_action', 1, 1, 1, 'enc:1:a:b', 1, 'bad', 0)`);
  });

  test("refuses a sent alert on a case that was never alerted", async () => {
    // Saying an alert went out for a revision nothing was alerted at can stop
    // the owner ever being told, once the case does need them.
    await expectRefused(`INSERT INTO payment_cases
      (payment_id, resource, resource_index, reason, state,
       first_observed_at, last_observed_at, next_reconcile_at,
       consecutive_count, evidence, revision,
       alert_sent_at, alert_sent_revision)
      VALUES ('sent-never-alerted', 'enc:1:a:b', 'sent-index',
        'network_error', 'retrying', 1, 1, 1, 1, 'enc:1:a:b', 1, 1, 1)`);
  });

  test("refuses an alert sent before it was decided on", async () => {
    // The sent version is what stops that version going out again, so a sent
    // time earlier than the alert itself can silence the real message.
    await expectRefused(`INSERT INTO payment_cases
      (payment_id, resource, resource_index, reason, state,
       first_observed_at, last_observed_at, consecutive_count, evidence,
       revision, alerted_at, alerted_revision, alert_sent_at,
       alert_sent_revision)
      VALUES ('sent-early', 'enc:1:a:b', 'sent-early-index',
        'network_error', 'needs_action', 1, 1, 1, 'enc:1:a:b', 1,
        100, 1, 1, 1)`);
  });

  test("refuses an empty claim on sending a case alert", async () => {
    await expectRefused(`INSERT INTO payment_cases
      (payment_id, resource, resource_index, reason, state,
       first_observed_at, last_observed_at, consecutive_count, evidence,
       revision, alerted_at, alerted_revision, alert_lease_token,
       alert_lease_expires_at)
      VALUES ('empty-alert-claim', 'enc:1:a:b', 'empty-alert-index',
        'network_error', 'needs_action', 1, 1, 1, 'enc:1:a:b', 1, 1, 1,
        '', 9)`);
  });

  test("refuses a claim on sending an alert that had already run out", async () => {
    // Spent on arrival, so a second worker can send the owner the same
    // message while the first still believes it holds the claim.
    await expectRefused(`INSERT INTO payment_cases
      (payment_id, resource, resource_index, reason, state,
       first_observed_at, last_observed_at, consecutive_count, evidence,
       revision, alerted_at, alerted_revision, alert_lease_token,
       alert_lease_expires_at)
      VALUES ('stale-alert-claim', 'enc:1:a:b', 'stale-alert-index',
        'network_error', 'needs_action', 100, 100, 1, 'enc:1:a:b', 1, 100, 1,
        'worker-1', 1)`);
  });

  test("refuses a case booked to retry before its newest reading", async () => {
    // Booking the next look before the last one makes it due at once, which
    // turns waiting between tries into asking the provider on a loop.
    await expectRefused(`INSERT INTO payment_cases
      (payment_id, resource, resource_index, reason, state,
       first_observed_at, last_observed_at, next_reconcile_at,
       consecutive_count, evidence, revision)
      VALUES ('retry-too-soon', 'enc:1:a:b', 'retry-soon-index',
        'network_error', 'retrying', 1, 100, 1, 1, 'enc:1:a:b', 1)`);
  });

  test("refuses a case whose lookup code is only spaces", async () => {
    await expectRefused(`INSERT INTO payment_cases
      (payment_id, resource, resource_index, reason, state,
       first_observed_at, last_observed_at, next_reconcile_at,
       consecutive_count, evidence, revision)
      VALUES ('spaces', 'enc:1:a:b', '   ', 'network_error', 'retrying',
        1, 1, 1, 1, 'enc:1:a:b', 1)`);
  });

  test("requires retrying cases to have a next reconcile time", async () => {
    await expectRefused(`INSERT INTO payment_cases
      (payment_id, resource, resource_index, reason, state,
       first_observed_at, last_observed_at, next_reconcile_at,
       consecutive_count, evidence, revision)
      VALUES ('payment', 'enc:1:a:b', 'index', 'network_error',
        'retrying', 1, 1, NULL, 1, 'enc:1:a:b', 1)`);
  });
});
