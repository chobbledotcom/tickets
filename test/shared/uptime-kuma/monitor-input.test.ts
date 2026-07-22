import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  groupMonitorInput,
  scheduledAuthorization,
  scheduledUrl,
  siteMonitorInput,
  UPTIME_KUMA_GROUP_NAME,
} from "#shared/uptime-kuma/monitor-input.ts";
import { testBuiltSite } from "#test-utils/factories.ts";
import { TEST_SCHEDULED_KEY } from "#test-utils/scheduled.ts";

const monitorDefaults = {
  accepted_statuscodes: ["200-299"],
  authMethod: "",
  body: null,
  conditions: [],
  databaseConnectionString: null,
  description: null,
  dns_resolve_server: "1.1.1.1",
  dns_resolve_type: "A",
  expiryNotification: false,
  headers: null,
  hostname: null,
  httpBodyEncoding: "json",
  ignoreTls: false,
  interval: 60,
  kafkaProducerBrokers: [],
  kafkaProducerSaslOptions: { mechanism: "None" },
  maxredirects: 10,
  maxretries: 1,
  method: "GET",
  mqttPassword: "",
  mqttSuccessMessage: "",
  mqttTopic: "",
  mqttUsername: "",
  notificationIDList: {},
  packetSize: 56,
  port: null,
  proxyId: null,
  rabbitmqNodes: [],
  resendInterval: 0,
  retryInterval: 60,
  timeout: 48,
  upsideDown: false,
  url: null,
};

const site = testBuiltSite({
  name: "Child site",
  siteUrl: "https://child.example.test/ignored/path",
});

describe("Uptime Kuma monitor input", () => {
  test("builds the shared group with Uptime Kuma 2 defaults", () => {
    expect(groupMonitorInput(2)).toEqual({
      ...monitorDefaults,
      name: "Chobble Tickets",
      parent: null,
      type: "group",
    });
    expect(UPTIME_KUMA_GROUP_NAME).toBe("Chobble Tickets");
  });

  test("builds the authenticated scheduled monitor", () => {
    expect(
      siteMonitorInput(
        site,
        {
          intervalSeconds: 900,
          password: "password",
          url: "https://kuma.example.test",
          username: "owner",
        },
        11,
        TEST_SCHEDULED_KEY,
        2,
      ),
    ).toEqual({
      ...monitorDefaults,
      headers: JSON.stringify({
        Authorization: scheduledAuthorization(TEST_SCHEDULED_KEY),
      }),
      interval: 900,
      method: "POST",
      name: "Child site",
      parent: 11,
      type: "http",
      url: scheduledUrl(site),
    });
  });

  test("omits Uptime Kuma 2 fields for a 1.x server", () => {
    const {
      conditions: _conditions,
      rabbitmqNodes: _rabbitmqNodes,
      ...versionOneDefaults
    } = monitorDefaults;
    expect(groupMonitorInput(1)).toEqual({
      ...versionOneDefaults,
      name: "Chobble Tickets",
      parent: null,
      type: "group",
    });
  });
});
