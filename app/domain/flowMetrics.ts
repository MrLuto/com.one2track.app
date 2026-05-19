import type { TrackerSnapshot } from "./types";

export const STATIONARY_SPEED_THRESHOLD_KMH = 0.5;

function isFiniteNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function crossedBelowThreshold(
  currentValue: number | null | undefined,
  previousValue: number | null | undefined,
  threshold: number,
): boolean {
  return isFiniteNumber(currentValue) && currentValue <= threshold && (!isFiniteNumber(previousValue) || previousValue > threshold);
}

export function crossedAboveThreshold(
  currentValue: number | null | undefined,
  previousValue: number | null | undefined,
  threshold: number,
): boolean {
  return isFiniteNumber(currentValue) && currentValue >= threshold && (!isFiniteNumber(previousValue) || previousValue < threshold);
}

export function calculateDistanceMeters(
  fromLatitude: number | null | undefined,
  fromLongitude: number | null | undefined,
  toLatitude: number | null | undefined,
  toLongitude: number | null | undefined,
): number | null {
  if (
    !isFiniteNumber(fromLatitude) ||
    !isFiniteNumber(fromLongitude) ||
    !isFiniteNumber(toLatitude) ||
    !isFiniteNumber(toLongitude)
  ) {
    return null;
  }

  const earthRadiusMeters = 6_371_000;
  const toRadians = (value: number): number => (value * Math.PI) / 180;
  const deltaLatitude = toRadians(toLatitude - fromLatitude);
  const deltaLongitude = toRadians(toLongitude - fromLongitude);
  const latitude1 = toRadians(fromLatitude);
  const latitude2 = toRadians(toLatitude);

  const haversine =
    Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(latitude1) * Math.cos(latitude2) * Math.sin(deltaLongitude / 2) ** 2;

  return 2 * earthRadiusMeters * Math.asin(Math.sqrt(haversine));
}

export function crossedIntoDistance(
  currentDistanceMeters: number | null | undefined,
  previousDistanceMeters: number | null | undefined,
  thresholdMeters: number,
): boolean {
  return (
    isFiniteNumber(currentDistanceMeters) &&
    currentDistanceMeters <= thresholdMeters &&
    isFiniteNumber(previousDistanceMeters) &&
    previousDistanceMeters > thresholdMeters
  );
}

export function crossedOutOfDistance(
  currentDistanceMeters: number | null | undefined,
  previousDistanceMeters: number | null | undefined,
  thresholdMeters: number,
): boolean {
  return (
    isFiniteNumber(currentDistanceMeters) &&
    currentDistanceMeters > thresholdMeters &&
    isFiniteNumber(previousDistanceMeters) &&
    previousDistanceMeters <= thresholdMeters
  );
}

export function getLocationAgeMinutes(snapshot: TrackerSnapshot | null, observedAtMs = Date.now()): number | null {
  const iso = snapshot?.lastLocationUpdate;
  if (!iso) {
    return null;
  }

  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) {
    return null;
  }

  return Math.max(0, (observedAtMs - timestamp) / 60_000);
}

export function isSnapshotStationary(snapshot: TrackerSnapshot | null): boolean {
  return isFiniteNumber(snapshot?.speedKmh) && snapshot.speedKmh <= STATIONARY_SPEED_THRESHOLD_KMH;
}
