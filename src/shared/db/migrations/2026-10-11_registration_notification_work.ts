import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-10-11_registration_notification_work",
  "Stage the durable work item that carries a paid booking's registration notification — its sealed ticket token and free texts — beside the booking, with the lease and delivery stamps the replay paths claim it by",
  {
    newTables: ["registration_notification_work"],
  },
);
