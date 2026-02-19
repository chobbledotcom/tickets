import { describe, expect, test } from "#test-compat";
import {
  addQueryLogEntry,
  enableQueryLog,
  getQueryLog,
  isQueryLogEnabled,
  runWithQueryLogContext,
} from "#lib/db/query-log.ts";

describe("query-log", () => {
  describe("enableQueryLog", () => {
    test("starts disabled", () => {
      runWithQueryLogContext(() => {
        expect(isQueryLogEnabled()).toBe(false);
      });
    });

    test("enableQueryLog enables tracking", () => {
      runWithQueryLogContext(() => {
        enableQueryLog();
        expect(isQueryLogEnabled()).toBe(true);
      });
    });
  });

  describe("addQueryLogEntry", () => {
    test("records entries when enabled", () => {
      runWithQueryLogContext(() => {
        enableQueryLog();
        addQueryLogEntry("SELECT 1", 1.5);
        addQueryLogEntry("SELECT 2", 2.3);
        const log = getQueryLog();
        expect(log).toHaveLength(2);
        expect(log[0]!.sql).toBe("SELECT 1");
        expect(log[0]!.durationMs).toBe(1.5);
        expect(log[1]!.sql).toBe("SELECT 2");
        expect(log[1]!.durationMs).toBe(2.3);
      });
    });

    test("ignores entries when disabled", () => {
      runWithQueryLogContext(() => {
        addQueryLogEntry("SELECT 1", 1.0);
        expect(getQueryLog()).toHaveLength(0);
      });
    });
  });

  describe("enableQueryLog resets previous entries", () => {
    test("clears log on enable", () => {
      runWithQueryLogContext(() => {
        enableQueryLog();
        addQueryLogEntry("SELECT old", 1.0);
        expect(getQueryLog()).toHaveLength(1);

        enableQueryLog();
        expect(getQueryLog()).toHaveLength(0);
      });
    });
  });

  describe("getQueryLog returns a snapshot", () => {
    test("returned array is independent of internal state", () => {
      runWithQueryLogContext(() => {
        enableQueryLog();
        addQueryLogEntry("SELECT 1", 1.0);
        const snapshot = getQueryLog();
        addQueryLogEntry("SELECT 2", 2.0);
        expect(snapshot).toHaveLength(1);
        expect(getQueryLog()).toHaveLength(2);
      });
    });
  });
});
