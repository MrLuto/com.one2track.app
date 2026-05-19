import { describe, expect, it } from "vitest";

import devicesFixture from "./fixtures/devices.json";
import { normalizeTrackerPayload } from "../app/domain/normalize";

describe("normalizeTrackerPayload", () => {
  it("maps One2Track payloads to internal snapshots", () => {
    const snapshot = normalizeTrackerPayload(
      devicesFixture[0].device,
      {
        device: {
          model_id: 77,
          model_name: "Connect UP",
          phonebook_count: 4,
          whitelist_count: 2,
          manufacturer: "One2Track",
        },
        last_location: {
          course: "182",
          created_at: "2026-05-15T10:00:00.000Z",
        },
      },
      {
        phonebook: [
          { name: "Mom", number: "+31600000001" },
          { name: "Dad", number: "+31600000002" },
        ],
        whitelist: ["+31600000003"],
        alarms: ["08:00-1"],
        quietTimes: [{ start: "08:30", end: "14:00" }],
        synced: true,
      },
      null,
    );

    expect(snapshot.trackerUuid).toBe("uuid-1");
    expect(snapshot.serialNumber).toBe("OT-123");
    expect(snapshot.status).toBe("gps");
    expect(snapshot.address).toBe("Main Street 1");
    expect(snapshot.latitude).toBe(52.1);
    expect(snapshot.longitude).toBe(5.1);
    expect(snapshot.speedKmh).toBe(12.4);
    expect(snapshot.batteryPercentage).toBe(88);
    expect(snapshot.tumbleDetected).toBe(true);
    expect(snapshot.stepCount).toBe(3210);
    expect(snapshot.accuracyMeters).toBe(9.1);
    expect(snapshot.headingDegrees).toBe(182);
    expect(snapshot.simBalanceEur).toBe(1.23);
    expect(snapshot.modelId).toBe(77);
    expect(snapshot.modelName).toBe("Connect UP");
    expect(snapshot.phonebookCount).toBe(4);
    expect(snapshot.whitelistCount).toBe(2);
  });

  it("ignores corrupt future last-location timestamps", () => {
    const snapshot = normalizeTrackerPayload({
      ...devicesFixture[0].device,
      last_location: {
        ...devicesFixture[0].device.last_location,
        last_location_update: "2099-01-01T00:00:00.000Z",
      },
    });

    expect(snapshot.lastLocationUpdate).toBeNull();
  });
});
