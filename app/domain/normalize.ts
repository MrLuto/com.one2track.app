import { findSupportedCode, mapModelName } from "./commands";
import { ParseError } from "./errors";
import type {
  RawDevicePageState,
  RawTrackerDevice,
  RawTrackerLocation,
  TrackerCapabilityProfile,
  TrackerSettingsCache,
  TrackerSnapshot,
  TrackerStatus,
} from "./types";

function normalizeStatus(input?: string | null): TrackerStatus {
  const normalized = (input ?? "").trim().toLowerCase();
  if (normalized === "gps") {
    return "gps";
  }

  if (normalized === "wifi") {
    return "wifi";
  }

  return "offline";
}

function parseOptionalNumber(value: number | string | undefined | null): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") {
      return null;
    }

    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function parseTumble(value?: string): boolean {
  return value === "true" || value === "1" || value?.toLowerCase() === "yes";
}

function parseOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function mergeLocation(
  jsonLocation: Partial<RawTrackerLocation>,
  htmlLocation: Record<string, unknown> | undefined,
): Partial<RawTrackerLocation> {
  if (!htmlLocation) {
    return jsonLocation;
  }

  return {
    ...jsonLocation,
    ...htmlLocation,
    meta_data: {
      ...(jsonLocation.meta_data ?? {}),
      ...((htmlLocation.meta_data as Record<string, unknown> | undefined) ?? {}),
    },
  };
}

function normalizeTimestamp(locationTimestamp: string | null, fallbackTimestamp: string | null): string | null {
  if (!locationTimestamp) {
    return fallbackTimestamp;
  }

  const timestamp = Date.parse(locationTimestamp);
  if (Number.isNaN(timestamp)) {
    return fallbackTimestamp;
  }

  if (timestamp > Date.now() + 24 * 60 * 60 * 1000) {
    return fallbackTimestamp;
  }

  return locationTimestamp;
}

export function normalizeTrackerPayload(
  payload: RawTrackerDevice,
  rawPageState: RawDevicePageState | null = null,
  settingsCache: TrackerSettingsCache | null = null,
  profile: TrackerCapabilityProfile | null = null,
): TrackerSnapshot {
  if (!payload.uuid || !payload.serial_number || !payload.name) {
    throw new ParseError("Tracker payload misses one or more required identifiers");
  }

  const pageDevice = rawPageState?.device ?? {};
  const pageLocation = rawPageState?.last_location ?? {};
  const location = mergeLocation(payload.last_location ?? {}, pageLocation);
  const meta = location.meta_data ?? {};
  const simBalanceCents = payload.simcard?.balance_cents;
  const modelId = parseOptionalNumber(
    payload.model_id ?? (pageDevice.model_id as string | number | undefined),
  );
  const explicitModelName =
    parseOptionalString(payload.model_name) ??
    parseOptionalString(pageDevice.model_name) ??
    parseOptionalString(pageDevice.model);
  const manufacturer = parseOptionalString(payload.manufacturer) ?? "One2Track";
  const phonebookCount =
    parseOptionalNumber((pageDevice.phonebook_count as string | number | undefined) ?? null) ??
    settingsCache?.phonebook.length ??
    null;
  const whitelistCount =
    parseOptionalNumber((pageDevice.whitelist_count as string | number | undefined) ?? null) ??
    settingsCache?.whitelist.length ??
    null;
  const normalizedLastLocationUpdate = normalizeTimestamp(
    location.last_location_update ?? null,
    parseOptionalString(pageLocation.created_at),
  );

  return {
    id: payload.id,
    trackerUuid: payload.uuid,
    serialNumber: payload.serial_number,
    name: payload.name,
    phoneNumber: payload.phone_number ?? parseOptionalString(pageDevice.phone_number),
    status: normalizeStatus(
      payload.status ?? parseOptionalString(pageDevice.status) ?? parseOptionalString(location.location_type),
    ),
    address: location.address ?? parseOptionalString(pageLocation.address),
    latitude: parseOptionalNumber(location.latitude),
    longitude: parseOptionalNumber(location.longitude),
    altitudeMeters: parseOptionalNumber(location.altitude),
    signalStrength: parseOptionalNumber(location.signal_strength),
    satelliteCount: parseOptionalNumber(location.satellite_count),
    speedKmh: parseOptionalNumber(location.speed),
    batteryPercentage: parseOptionalNumber(location.battery_percentage),
    tumbleDetected: parseTumble(meta.tumble),
    stepCount: parseOptionalNumber(meta.steps),
    accuracyMeters: parseOptionalNumber(meta.accuracy_meters ?? meta.accuracy),
    headingDegrees:
      parseOptionalNumber(meta.course) ??
      parseOptionalNumber(pageLocation.course as string | number | undefined) ??
      null,
    locationType: location.location_type ?? parseOptionalString(pageLocation.location_type),
    simBalanceEur: typeof simBalanceCents === "number" ? simBalanceCents / 100 : null,
    lastCommunication: location.last_communication ?? parseOptionalString(pageLocation.last_communication),
    lastLocationUpdate: normalizedLastLocationUpdate,
    modelId,
    modelName: mapModelName(modelId, explicitModelName),
    manufacturer,
    phonebookCount,
    whitelistCount,
    profile,
  };
}

export function parseCommandSelection(
  value: string,
  profile: TrackerCapabilityProfile | null,
  codeKey: keyof TrackerCapabilityProfile["codes"],
): string {
  const selected = value.trim();
  if (!selected) {
    throw new ParseError("A command option value is required");
  }

  const code = profile?.codes[codeKey];
  const options = code ? profile?.options[code] ?? [] : [];
  if (options.length === 0) {
    return selected;
  }

  if (options.some((option) => option.value === selected)) {
    return selected;
  }

  throw new ParseError(`Unknown command option '${selected}' for ${String(codeKey)}`);
}

export function inferBooleanCommandValue(
  profile: TrackerCapabilityProfile | null,
  codeKey: keyof TrackerCapabilityProfile["codes"],
  enabled: boolean,
): string | null {
  const code = profile?.codes[codeKey];
  if (!code) {
    return null;
  }

  const options = profile.options[code] ?? [];
  if (options.length !== 2) {
    return null;
  }

  const positive = options.find((option) => /on|enable|enabled|aan|active|yes|open/i.test(option.label));
  const negative = options.find((option) => /off|disable|disabled|uit|inactive|no|closed/i.test(option.label));

  if (positive && negative) {
    return enabled ? positive.value : negative.value;
  }

  return enabled ? options[0]?.value ?? null : options[1]?.value ?? null;
}

export function inferCheckedCommandValue(
  profile: TrackerCapabilityProfile | null,
  codeKey: keyof TrackerCapabilityProfile["codes"],
): string | null {
  const code = profile?.codes[codeKey];
  if (!code) {
    return null;
  }

  return profile.options[code]?.find((option) => option.checked)?.value ?? null;
}

export function findProfileCode(
  profile: TrackerCapabilityProfile | null,
  candidates: readonly string[],
): string | undefined {
  if (!profile) {
    return undefined;
  }

  return findSupportedCode(profile.functions, candidates);
}
