import { describe, expect, it } from "vitest";

import { detectSnapshotChanges } from "../app/domain/changeDetector";
import type { TrackerSnapshot } from "../app/domain/types";

const baseSnapshot: TrackerSnapshot = {
  id: 1,
  trackerUuid: "uuid-1",
  serialNumber: "SER-1",
  name: "Tracker",
  phoneNumber: null,
  status: "gps",
  address: "Address",
  latitude: 52.1,
  longitude: 5.1,
  altitudeMeters: 4,
  signalStrength: 75,
  satelliteCount: 6,
  speedKmh: 11,
  batteryPercentage: 80,
  tumbleDetected: false,
  stepCount: 100,
  accuracyMeters: 8,
  headingDegrees: 180,
  locationType: "GPS",
  simBalanceEur: 1.2,
  lastCommunication: "2026-05-15T10:00:00.000Z",
  lastLocationUpdate: "2026-05-15T10:00:00.000Z",
  modelId: 77,
  modelName: "Connect UP",
  manufacturer: "One2Track",
  phonebookCount: 2,
  whitelistCount: 3,
  profile: null,
};

describe("detectSnapshotChanges", () => {
  it("flags meaningful changes between snapshots", () => {
    const current: TrackerSnapshot = {
      ...baseSnapshot,
      status: "offline",
      tumbleDetected: true,
      latitude: 52.2,
      lastLocationUpdate: "2026-05-15T10:01:00.000Z",
    };

    const changes = detectSnapshotChanges(current, baseSnapshot);

    expect(changes.locationChanged).toBe(true);
    expect(changes.statusChanged).toBe(true);
    expect(changes.wentOffline).toBe(true);
    expect(changes.cameOnline).toBe(false);
    expect(changes.tumbleDetected).toBe(true);
    expect(changes.tumbleCleared).toBe(false);
    expect(changes.batteryChanged).toBe(false);
    expect(changes.simBalanceChanged).toBe(false);
    expect(changes.speedChanged).toBe(false);
    expect(changes.stepCountChanged).toBe(false);
  });

  it("treats the first snapshot as an initial online update", () => {
    const changes = detectSnapshotChanges(baseSnapshot, null);

    expect(changes.statusChanged).toBe(true);
    expect(changes.cameOnline).toBe(true);
    expect(changes.wentOffline).toBe(false);
    expect(changes.batteryChanged).toBe(true);
    expect(changes.simBalanceChanged).toBe(true);
    expect(changes.speedChanged).toBe(true);
    expect(changes.stepCountChanged).toBe(true);
  });
});
