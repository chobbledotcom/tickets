import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  adminBackupPage,
  adminRestoreConfirmPage,
  type BackupPageState,
  RESTORE_CONFIRM_PHRASE,
} from "#templates/admin/backup.tsx";
import { describeWithEnv } from "#test-utils";

const mockSession = {
  token: "test-token",
  wrappedDataKey: null,
  userId: 1,
  adminLevel: "owner" as const,
};

const baseState: BackupPageState = {
  backups: [],
  encryptionKey: "dGVzdC1rZXktMTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0",
  isRemote: true,
  storageEnabled: true,
};

describeWithEnv("backup template", { encryptionKey: true }, () => {
  test("renders page title", () => {
    const html = adminBackupPage(mockSession, baseState);
    expect(html).toContain("Database Backup");
  });

  test("displays encryption key", () => {
    const html = adminBackupPage(mockSession, baseState);
    expect(html).toContain(baseState.encryptionKey);
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
    expect(html).toContain("Create Backup Now");
    expect(html).toContain("/admin/backup/create");
  });

  test("hides backup forms when storage disabled", () => {
    const html = adminBackupPage(mockSession, {
      ...baseState,
      storageEnabled: false,
    });
    expect(html).not.toContain("Create Backup Now");
    expect(html).not.toContain("Restore from Backup");
  });

  test("shows no backups message when list is empty", () => {
    const html = adminBackupPage(mockSession, baseState);
    expect(html).toContain("No backups found");
  });

  test("renders backup list as table", () => {
    const html = adminBackupPage(mockSession, {
      ...baseState,
      backups: [
        {
          filename: "backup-2024-01-15T12-00-00-000Z.zip",
          timestamp: "2024-01-15T12-00-00-000Z",
        },
      ],
    });
    expect(html).toContain("2024-01-15T12-00-00-000Z");
    expect(html).toContain("Download");
    expect(html).toContain(
      "/admin/backup/download/backup-2024-01-15T12-00-00-000Z.zip",
    );
  });

  test("renders restore form with file upload for .zip", () => {
    const html = adminBackupPage(mockSession, baseState);
    expect(html).toContain("Restore from Backup");
    expect(html).toContain('type="file"');
    expect(html).toContain('accept=".zip"');
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

  test("restore confirm page shows statement count", () => {
    const html = adminRestoreConfirmPage(mockSession, "test.zip", 42);
    expect(html).toContain("42");
    expect(html).toContain("SQL statements");
  });

  test("restore confirm page shows confirmation phrase", () => {
    const html = adminRestoreConfirmPage(mockSession, "test.zip", 10);
    expect(html).toContain(RESTORE_CONFIRM_PHRASE);
  });

  test("restore confirm page includes hidden backup filename", () => {
    const html = adminRestoreConfirmPage(
      mockSession,
      "restore-pending-abc.zip",
      5,
    );
    expect(html).toContain("restore-pending-abc.zip");
    expect(html).toContain('name="backup_filename"');
  });

  test("restore confirm page renders error when provided", () => {
    const html = adminRestoreConfirmPage(
      mockSession,
      "test.zip",
      10,
      "Phrase mismatch",
    );
    expect(html).toContain("Phrase mismatch");
    expect(html).toContain("error");
  });

  test("RESTORE_CONFIRM_PHRASE is RESTORE DATABASE", () => {
    expect(RESTORE_CONFIRM_PHRASE).toBe("RESTORE DATABASE");
  });
});
