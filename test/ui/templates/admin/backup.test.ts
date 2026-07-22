import { expect } from "@std/expect";
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
  backups: [],
  encryptionKey: "dGVzdC1rZXktMTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0",
  isRemote: true,
  maxBackups: 30,
  storageEnabled: true,
};

describeWithEnv("backup template", { encryptionKey: true }, () => {
  test("renders page title", () => {
    const html = adminBackupPage(mockSession, baseState);
    expect(html).toContain("Database backup");
    expect(html).toContain('class="active" href="/admin/backup"');
  });

  test("displays encryption key", () => {
    const html = adminBackupPage(mockSession, baseState);
    expect(html).toContain(baseState.encryptionKey);
    expect(html).toContain('<section><div class="prose"><h2>Encryption key');
  });

  test("shows local database warning when not remote", () => {
    const html = adminBackupPage(mockSession, {
      ...baseState,
      isRemote: false,
    });
    expect(html).toContain("local database");
  });

  test("does not show local warning when remote", () => {
    const html = adminBackupPage(mockSession, baseState);
    expect(html).not.toContain("local database");
  });

  test("shows storage not configured warning when disabled", () => {
    const html = adminBackupPage(mockSession, {
      ...baseState,
      storageEnabled: false,
    });
    expect(html).toContain("Storage is not configured");
  });

  test("shows create backup form when storage enabled", () => {
    const html = adminBackupPage(mockSession, baseState);
    expect(html).toContain("Create backup now");
    expect(html).toContain("/admin/backup/create");
    expect(html).toContain('class="no-bg"');
    expect(html).toContain('id="backup-create"');
    expect(html).toContain('<section><div class="prose"><h2>Create backup');
  });

  test("hides the create form when storage is disabled", () => {
    const html = adminBackupPage(mockSession, {
      ...baseState,
      storageEnabled: false,
    });
    expect(html).not.toContain("Create backup now");
    expect(html).toContain("Restore from backup");
  });

  test("shows no backups message when list is empty", () => {
    const html = adminBackupPage(mockSession, baseState);
    expect(html).toContain("No backups found");
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
    expect(html).toContain("Monday 15 January 2024 at 12:00 UTC");
    expect(html).toContain("<code>2024-01-15T12-00-00-000Z</code>");
    expect(html).toContain("Timestamp");
    expect(html).toContain("1MB");
    expect(html).toContain("Download");
    expect(html).toContain(
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
    expect(html).toContain('<div class="prose"><p>There is 1 backup');
    expect(html).toContain("There is 1 backup");
    expect(html).toContain("Up to 30 are kept");
    expect(html).toContain(
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
    expect(html).toContain("1 more can be created before the oldest is purged");
    expect(html).not.toContain("the next will purge the oldest");
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
    expect(html).toContain("There are 3 backups");
    expect(html).toContain("the next will purge the oldest (backup 1)");
  });

  test("shows the out-of-band restore command without a web form", () => {
    const html = adminBackupPage(mockSession, baseState);
    expect(html).toContain("deno task restore &lt;backup.zip&gt;");
    expect(html).toContain("large restore exceeds the edge request limit");
    expect(html).not.toContain("/admin/backup/restore");
    expect(html).toContain(
      '<section><div class="prose"><h2>Restore from backup',
    );
    expect(html).toContain('href="/admin/guide#backups"');
  });

  test("shows error message when provided", () => {
    const html = adminBackupPage(
      mockSession,
      baseState,
      "Something went wrong",
    );
    expect(html).toContain("Something went wrong");
    expect(html).toContain("error");
  });

  test("shows success message when provided", () => {
    const html = adminBackupPage(
      mockSession,
      baseState,
      undefined,
      "Backup created",
    );
    expect(html).toContain("Backup created");
    expect(html).toContain("success");
  });
});
