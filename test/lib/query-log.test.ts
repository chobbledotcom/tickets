import { afterEach, describe, expect, test } from "#test-compat";
import {
  addQueryLogEntry,
  disableQueryLog,
  enableQueryLog,
  getQueryLog,
  isQueryLogEnabled,
} from "#lib/db/query-log.ts";

describe("query-log", () => {
  afterEach(() => {
    disableQueryLog();
  });

  describe("enableQueryLog / disableQueryLog", () => {
    test("starts disabled", () => {
      expect(isQueryLogEnabled()).toBe(false);
    });

    test("enableQueryLog enables tracking", () => {
      enableQueryLog();
      expect(isQueryLogEnabled()).toBe(true);
    });

    test("disableQueryLog disables tracking", () => {
      enableQueryLog();
      disableQueryLog();
      expect(isQueryLogEnabled()).toBe(false);
    });
  });

  describe("addQueryLogEntry", () => {
    test("records entries when enabled", () => {
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

    test("ignores entries when disabled", () => {
      addQueryLogEntry("SELECT 1", 1.0);
      expect(getQueryLog()).toHaveLength(0);
    });
  });

  describe("enableQueryLog resets previous entries", () => {
    test("clears log on enable", () => {
      enableQueryLog();
      addQueryLogEntry("SELECT old", 1.0);
      expect(getQueryLog()).toHaveLength(1);

      enableQueryLog();
      expect(getQueryLog()).toHaveLength(0);
    });
  });

  describe("getQueryLog returns a snapshot", () => {
    test("returned array is independent of internal state", () => {
      enableQueryLog();
      addQueryLogEntry("SELECT 1", 1.0);
      const snapshot = getQueryLog();
      addQueryLogEntry("SELECT 2", 2.0);
      expect(snapshot).toHaveLength(1);
      expect(getQueryLog()).toHaveLength(2);
    });
  });
});
