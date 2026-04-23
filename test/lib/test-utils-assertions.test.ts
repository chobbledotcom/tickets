import { describeWithEnv, testRequiresAuth } from "#test-utils";

describeWithEnv("test-utils/assertions", { db: true }, () => {
  testRequiresAuth("/admin/settings");

  testRequiresAuth("/admin/groups", {
    method: "POST",
    body: { name: "test" },
  });

  testRequiresAuth("/admin/event", {
    multipart: true,
    body: { name: "test", max_attendees: "10" },
  });

  testRequiresAuth("/admin/backup", {
    setup: async () => {
      const { setTestEnv } = await import("#test-utils");
      setTestEnv({ BUNNY_API_KEY: "test" });
    },
  });
});