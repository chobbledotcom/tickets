import { assert, assertStringIncludes } from "@std/assert";
import { it as test } from "@std/testing/bdd";
import {
  adminBackupPage,
  type BackupPageState,
} from "#templates/admin/backup.tsx";
import { describeWithEnv } from "#test-utils/db.ts";

const mockSession = {
  adminLevel: "owner" as const,
  token: "test-token",
  userId: 1,
  wrappedDataKey: null,
};

const baseState: BackupPageState = {
  backupFolder: "my-site/",
  backups: [],
  createBlocked: null,
  encryptionKey: "dGVzdC1rZXktMTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0",
  isRemote: true,
  listingError: null,
  maxBackups: 30,
  storageEnabled: true,
  storageZone: null,
};

describeWithEnv("backup template", { encryptionKey: true }, () => {
  test("renders page title", () => {
    const html = adminBackupPage(mockSession, baseState);
    assertStringIncludes(html, "Database backup");
    assertStringIncludes(html, 'class="active" href="/admin/backup"');
  });

  test("displays encryption key", () => {
    const html = adminBackupPage(mockSession, baseState);
    assertStringIncludes(html, baseState.encryptionKey);
    assertStringIncludes(
      html,
      '<section><div class="prose"><h2>Encryption key',
    );
  });

  test("shows local database warning when not remote", () => {
    const html = adminBackupPage(mockSession, {
      ...baseState,
      isRemote: false,
    });
    assertStringIncludes(html, "local database");
  });

  test("does not show local warning when remote", () => {
    const html = adminBackupPage(mockSession, baseState);
    assert(!html.includes("local database"));
  });

  test("shows storage not configured warning when disabled", () => {
    const html = adminBackupPage(mockSession, {
      ...baseState,
      storageEnabled: false,
    });
    assertStringIncludes(html, "Storage is not configured");
  });

  test("shows create backup form when storage enabled", () => {
    const html = adminBackupPage(mockSession, baseState);
    assertStringIncludes(html, "Create backup now");
    assertStringIncludes(html, "/admin/backup/create");
    assertStringIncludes(html, 'class="no-bg"');
    assertStringIncludes(html, 'id="backup-create"');
    assertStringIncludes(html, '<section><div class="prose"><h2>Create backup');
  });

  test("hides the create form when storage is disabled", () => {
    const html = adminBackupPage(mockSession, {
      ...baseState,
      storageEnabled: false,
    });
    assert(!html.includes("Create backup now"));
    assertStringIncludes(html, "Restore from backup");
  });

  test("shows no backups message when list is empty", () => {
    const html = adminBackupPage(mockSession, baseState);
    assertStringIncludes(html, "No backups found");
  });

  test("names the folder backups live in", () => {
    const html = adminBackupPage(mockSession, baseState);
    assertStringIncludes(
      html,
      "Backups for this database live in the my-site/ folder.",
    );
  });

  test("names the storage zone when one is configured", () => {
    const html = adminBackupPage(mockSession, {
      ...baseState,
      storageZone: "zone-a",
    });
    assertStringIncludes(
      html,
      "Backups for this database live in the my-site/ folder of the zone-a storage zone.",
    );
  });

  test("shows a listing failure instead of an empty list", () => {
    const html = adminBackupPage(mockSession, {
      ...baseState,
      listingError: "Storage listing for my-site/ failed: HTTP 401",
    });
    assertStringIncludes(
      html,
      "Could not read the list of backups: Storage listing for my-site/ failed: HTTP 401",
    );
    assert(!html.includes("No backups found"));
  });

  test("replaces the create button when the dump cannot fit one request", () => {
    const html = adminBackupPage(mockSession, {
      ...baseState,
      createBlocked: { available: 43, needed: 120 },
    });
    assertStringIncludes(html, "too big to back up from this page");
    assertStringIncludes(html, "120 database calls");
    assertStringIncludes(html, "only allows 43");
    assertStringIncludes(html, "deno task backup");
    assert(!html.includes("/admin/backup/create"));
  });

  test("renders backup list as table with friendly date, timestamp, and size", () => {
    const html = adminBackupPage(mockSession, {
      ...baseState,
      backups: [
        {
          filename: "backup-2024-01-15T12-00-00-000Z.zip",
          label: "Monday 15 January 2024 at 12:00 UTC",
          sizeLabel: "1MB",
          timestamp: "2024-01-15T12-00-00-000Z",
        },
      ],
    });
    assertStringIncludes(html, "Monday 15 January 2024 at 12:00 UTC");
    assertStringIncludes(html, "<code>2024-01-15T12-00-00-000Z</code>");
    assertStringIncludes(html, "Timestamp");
    assertStringIncludes(html, "1MB");
    assertStringIncludes(html, "Download");
    assertStringIncludes(
      html,
      "/admin/backup/download/backup-2024-01-15T12-00-00-000Z.zip",
    );
  });

  test("retention note counts backups and reports remaining capacity", () => {
    const html = adminBackupPage(mockSession, {
      ...baseState,
      backups: [
        {
          filename: "backup-2024-01-15T12-00-00-000Z.zip",
          label: "Monday 15 January 2024 at 12:00 UTC",
          sizeLabel: "1MB",
          timestamp: "2024-01-15T12-00-00-000Z",
        },
      ],
      maxBackups: 30,
    });
    assertStringIncludes(html, '<div class="prose"><p>There is 1 backup');
    assertStringIncludes(html, "There is 1 backup");
    assertStringIncludes(html, "Up to 30 are kept");
    assertStringIncludes(
      html,
      "29 more can be created before the oldest is purged",
    );
  });

  test("retention keeps the last available backup slot", () => {
    const html = adminBackupPage(mockSession, {
      ...baseState,
      backups: [
        {
          filename: "backup-2024-01-15T12-00-00-000Z.zip",
          label: "Monday 15 January 2024 at 12:00 UTC",
          sizeLabel: "1MB",
          timestamp: "2024-01-15T12-00-00-000Z",
        },
      ],
      maxBackups: 2,
    });
    assertStringIncludes(
      html,
      "1 more can be created before the oldest is purged",
    );
    assert(!html.includes("the next will purge the oldest"));
  });

  test("retention note warns the oldest is purged next when at capacity", () => {
    const entry = (n: number): BackupPageState["backups"][number] => {
      const day = String(n).padStart(2, "0");
      return {
        filename: `backup-2024-01-${day}T12-00-00-000Z.zip`,
        label: `backup ${n}`,
        sizeLabel: "1MB",
        timestamp: `2024-01-${day}T12-00-00-000Z`,
      };
    };
    const html = adminBackupPage(mockSession, {
      ...baseState,
      // newest first: oldest is the last entry
      backups: [entry(3), entry(2), entry(1)],
      maxBackups: 3,
    });
    assertStringIncludes(html, "There are 3 backups");
    assertStringIncludes(html, "the next will purge the oldest (backup 1)");
  });

  test("shows the out-of-band restore command without a web form", () => {
    const html = adminBackupPage(mockSession, baseState);
    assertStringIncludes(html, "deno task restore &lt;backup.zip&gt;");
    assertStringIncludes(html, "large restore exceeds the edge request limit");
    assert(!html.includes("/admin/backup/restore"));
    assertStringIncludes(
      html,
      '<section><div class="prose"><h2>Restore from backup',
    );
    assertStringIncludes(html, 'href="/admin/guide#backups"');
  });

  test("shows error message when provided", () => {
    const html = adminBackupPage(
      mockSession,
      baseState,
      "Something went wrong",
    );
    assertStringIncludes(html, "Something went wrong");
    assertStringIncludes(html, "error");
  });

  test("shows success message when provided", () => {
    const html = adminBackupPage(
      mockSession,
      baseState,
      undefined,
      "Backup created",
    );
    assertStringIncludes(html, "Backup created");
    assertStringIncludes(html, "success");
  });
});
