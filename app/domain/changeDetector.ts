import type { TrackerSnapshot } from "./types";

export type SnapshotChangeSet = {
  locationChanged: boolean;
  statusChanged: boolean;
  wentOffline: boolean;
  cameOnline: boolean;
  tumbleDetected: boolean;
  tumbleCleared: boolean;
  batteryChanged: boolean;
  simBalanceChanged: boolean;
  speedChanged: boolean;
  stepCountChanged: boolean;
};

function changedNumber(current: number | null, previous: number | null): boolean {
  return current !== previous;
}

function hasDifferentLocation(current: TrackerSnapshot, previous: TrackerSnapshot): boolean {
  return (
    current.lastLocationUpdate !== previous.lastLocationUpdate ||
    current.latitude !== previous.latitude ||
    current.longitude !== previous.longitude ||
    current.address !== previous.address
  );
}

export function detectSnapshotChanges(
  current: TrackerSnapshot,
  previous: TrackerSnapshot | null,
): SnapshotChangeSet {
  if (!previous) {
    return {
      locationChanged: Boolean(current.lastLocationUpdate || current.latitude || current.longitude),
      statusChanged: true,
      wentOffline: current.status === "offline",
      cameOnline: current.status !== "offline",
      tumbleDetected: current.tumbleDetected,
      tumbleCleared: false,
      batteryChanged: current.batteryPercentage !== null,
      simBalanceChanged: current.simBalanceEur !== null,
      speedChanged: current.speedKmh !== null,
      stepCountChanged: current.stepCount !== null,
    };
  }

  return {
    locationChanged: hasDifferentLocation(current, previous),
    statusChanged: current.status !== previous.status,
    wentOffline: previous.status !== "offline" && current.status === "offline",
    cameOnline: previous.status === "offline" && current.status !== "offline",
    tumbleDetected: !previous.tumbleDetected && current.tumbleDetected,
    tumbleCleared: previous.tumbleDetected && !current.tumbleDetected,
    batteryChanged: changedNumber(current.batteryPercentage, previous.batteryPercentage),
    simBalanceChanged: changedNumber(current.simBalanceEur, previous.simBalanceEur),
    speedChanged: changedNumber(current.speedKmh, previous.speedKmh),
    stepCountChanged: changedNumber(current.stepCount, previous.stepCount),
  };
}
