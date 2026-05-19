import { describe, expect, it } from "vitest";

import {
  calculateDistanceMeters,
  crossedAboveThreshold,
  crossedBelowThreshold,
  crossedIntoDistance,
  crossedOutOfDistance,
  getLocationAgeMinutes,
  isSnapshotStationary,
  STATIONARY_SPEED_THRESHOLD_KMH,
} from "../app/domain/flowMetrics";
import type { TrackerSnapshot } from "../app/domain/types";

const snapshot: TrackerSnapshot = {
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
  speedKmh: 0.2,
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

describe("flowMetrics", () => {
  it("detects threshold crossings", () => {
    expect(crossedBelowThreshold(19, 21, 20)).toBe(true);
    expect(crossedBelowThreshold(19, 18, 20)).toBe(false);
    expect(crossedAboveThreshold(5.5, 4.5, 5)).toBe(true);
    expect(crossedAboveThreshold(5.5, 6, 5)).toBe(false);
  });

  it("detects distance crossings", () => {
    expect(crossedIntoDistance(95, 105, 100)).toBe(true);
    expect(crossedIntoDistance(95, 50, 100)).toBe(false);
    expect(crossedOutOfDistance(101, 100, 100)).toBe(true);
    expect(crossedOutOfDistance(50, 25, 100)).toBe(false);
  });

  it("calculates non-zero geographic distances", () => {
    const distance = calculateDistanceMeters(52.1, 5.1, 52.1005, 5.1005);
    expect(distance).not.toBeNull();
    expect(distance).toBeGreaterThan(0);
  });

  it("calculates location age in minutes", () => {
    const observedAtMs = Date.parse("2026-05-15T10:30:00.000Z");
    expect(getLocationAgeMinutes(snapshot, observedAtMs)).toBe(30);
    expect(getLocationAgeMinutes({ ...snapshot, lastLocationUpdate: null }, observedAtMs)).toBeNull();
  });

  it("marks low-speed snapshots as stationary", () => {
    expect(isSnapshotStationary(snapshot)).toBe(true);
    expect(isSnapshotStationary({ ...snapshot, speedKmh: STATIONARY_SPEED_THRESHOLD_KMH + 0.1 })).toBe(false);
  });
});
