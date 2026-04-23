import { describeWithEnv, testRequiresAuth } from "#test-utils";

describeWithEnv("test-utils/assertions", { db: true }, () => {
  testRequiresAuth("/admin/settings");

  testRequiresAuth("/admin/groups", {
    body: { name: "test" },
    method: "POST",
  });

  testRequiresAuth("/admin/event", {
    body: { max_attendees: "10", name: "test" },
    multipart: true,
  });

  testRequiresAuth("/admin/backup", {
    setup: async () => {
      const { setTestEnv } = await import("#test-utils");
      setTestEnv({ BUNNY_API_KEY: "test" });
    },
  });
});
