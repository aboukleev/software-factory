import Database from "better-sqlite3";

export default function enableNotificationBrowserFixture() {
  const sqlite = new Database("data.db");

  try {
    sqlite
      .prepare(
        `UPDATE notification_operation_controls
         SET creation_enabled = true,
             dispatch_enabled = true,
             feed_enabled = true,
             updated_at = ?
         WHERE id = 1`
      )
      .run(new Date().toISOString());
  } finally {
    sqlite.close();
  }
}
