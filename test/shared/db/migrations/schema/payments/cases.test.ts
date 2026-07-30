import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#shared/db/client.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  expectAccepted,
  expectRefused,
  expectRefusedAsRepeat,
} from "./refuses.ts";

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

  test("refuses clearing a problem's evidence before it is settled", async () => {
    // Comparing against a settled time that is not there passes in SQLite, so
    // the settled time has to be demanded outright.
    await expectRefused(`INSERT INTO payment_cases
      (payment_id, resource, resource_index, reason, state,
       first_observed_at, last_observed_at, next_reconcile_at,
       consecutive_count, evidence, revision, evidence_redacted_at)
      VALUES ('cleared-early', 'enc:1:a:b', 'cleared-early-index',
        'network_error', 'retrying', 1, 1, 1, 1, 'enc:1:a:b', 1, 100)`);
  });

  test("refuses a problem booked to be looked at before its newest reading", async () => {
    await expectRefused(`INSERT INTO payment_cases
      (payment_id, resource, resource_index, reason, state,
       first_observed_at, last_observed_at, next_reconcile_at,
       consecutive_count, evidence, revision)
      VALUES ('look-too-soon', 'enc:1:a:b', 'look-soon-index',
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

  test("refuses a problem that has never once failed", async () => {
    // A case is written because something went wrong, so it has failed at
    // least once. A count of none is what turns "try again" into "ask the
    // owner" too early, or never.
    await expectRefused(`INSERT INTO payment_cases
      (payment_id, resource, resource_index, reason, state,
       first_observed_at, last_observed_at, consecutive_count, evidence,
       revision)
      VALUES ('never-failed', 'enc:1:a:b', 'never-failed-index',
        'network_error', 'needs_action', 1, 1, 0, 'enc:1:a:b', 1)`);
  });

  test("refuses an alert about a version of the problem before its first", async () => {
    // Versions count from one, so an alert at version nothing names no
    // version the owner could ever have been shown.
    await expectRefused(`INSERT INTO payment_cases
      (payment_id, resource, resource_index, reason, state,
       first_observed_at, last_observed_at, consecutive_count, evidence,
       revision, alerted_at, alerted_revision)
      VALUES ('alert-at-nothing', 'enc:1:a:b', 'alert-at-nothing-index',
        'network_error', 'needs_action', 1, 1, 1, 'enc:1:a:b', 1, 1, 0)`);
  });

  test("refuses a problem whose own version counts from nothing", async () => {
    await expectRefused(`INSERT INTO payment_cases
      (payment_id, resource, resource_index, reason, state,
       first_observed_at, last_observed_at, consecutive_count, evidence,
       revision)
      VALUES ('version-nothing', 'enc:1:a:b', 'version-nothing-index',
        'network_error', 'needs_action', 1, 1, 1, 'enc:1:a:b', 0)`);
  });

  test("starts a problem at version one when the write does not say", async () => {
    // The version is what an owner settles against, so a row written without
    // one still has to be at a version they can be shown.
    await expectAccepted(`INSERT INTO payment_cases
      (payment_id, resource, resource_index, reason, state,
       first_observed_at, last_observed_at, consecutive_count, evidence)
      VALUES ('no-version-given', 'enc:1:a:b', 'no-version-given-index',
        'network_error', 'needs_action', 1, 1, 1, 'enc:1:a:b')`);
    const saved = await getDb().execute(
      `SELECT revision FROM payment_cases WHERE payment_id = 'no-version-given'`,
    );
    expect(Number(saved.rows[0]?.revision)).toBe(1);
  });

  test("keeps a settled time as a number, even when written as text", async () => {
    // The column says INTEGER, so SQLite turns a written number into one on
    // the way in. Without that the rules demanding a real time would refuse
    // every settled case a caller wrote as text.
    await expectAccepted(`INSERT INTO payment_cases
      (payment_id, resource, resource_index, reason, state,
       first_observed_at, last_observed_at, consecutive_count, evidence,
       revision, resolved_at)
      VALUES ('settled-as-text', 'enc:1:a:b', 'settled-as-text-index',
        'network_error', 'resolved', 1, 1, 1, 'enc:1:a:b', 1, '100')`);
    const saved = await getDb().execute(
      `SELECT typeof(resolved_at) AS kind, resolved_at FROM payment_cases
        WHERE payment_id = 'settled-as-text'`,
    );
    expect(saved.rows[0]?.kind).toBe("integer");
    expect(Number(saved.rows[0]?.resolved_at)).toBe(100);
  });

  test("refuses a second problem about the same thing on one payment", async () => {
    // Seeing the same problem again has to update the one row, or an owner
    // is asked to settle the same thing over and over.
    await expectAccepted(`INSERT INTO payment_cases
      (payment_id, resource, resource_index, reason, state,
       first_observed_at, last_observed_at, consecutive_count, evidence,
       revision)
      VALUES ('seen-twice', 'enc:1:a:b', 'seen-twice-index', 'network_error',
        'needs_action', 1, 1, 1, 'enc:1:a:b', 1)`);
    await expectRefusedAsRepeat(`INSERT INTO payment_cases
      (payment_id, resource, resource_index, reason, state,
       first_observed_at, last_observed_at, consecutive_count, evidence,
       revision)
      VALUES ('seen-twice', 'enc:1:a:b', 'seen-twice-index', 'timeout',
        'retrying', 2, 2, 2, 'enc:1:a:b', 2)`);
  });
});
