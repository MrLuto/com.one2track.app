import type { CommandOption, TrackerCapabilityProfile } from "./types";

export const COMMAND_CODES = {
  refreshLocation: "0039",
  findDevice: "1015",
  sosNumber: "0001",
  factoryReset: "0011",
  remoteShutdown: "0048",
  alarms: "0057",
  languageTimezone: "0124",
  quietTimes: "1107",
  phonebook: "1315",
  intercom: "0084",
  changePassword: "0067",
  whitelistPrimary: "0080",
  whitelistSecondary: "0081",
  profileMode: "1116",
} as const;

export const GPS_INTERVAL_CODES = ["0077", "0078"] as const;
export const STEP_COUNTER_CODES = ["0079", "0082"] as const;

export function findSupportedCode(
  functions: Record<string, string>,
  candidates: readonly string[],
): string | undefined {
  return candidates.find((code) => code in functions);
}

export function buildCapabilityProfile(
  functions: Record<string, string>,
  options: Record<string, CommandOption[]>,
): TrackerCapabilityProfile {
  const gpsInterval = findSupportedCode(functions, GPS_INTERVAL_CODES);
  const stepCounter = findSupportedCode(functions, STEP_COUNTER_CODES);
  const profileMode = COMMAND_CODES.profileMode in functions ? COMMAND_CODES.profileMode : undefined;

  return {
    functions,
    options,
    discoveredAt: new Date().toISOString(),
    codes: {
      refreshLocation: COMMAND_CODES.refreshLocation in functions ? COMMAND_CODES.refreshLocation : undefined,
      findDevice: COMMAND_CODES.findDevice in functions ? COMMAND_CODES.findDevice : undefined,
      sosNumber: COMMAND_CODES.sosNumber in functions ? COMMAND_CODES.sosNumber : undefined,
      alarms: COMMAND_CODES.alarms in functions ? COMMAND_CODES.alarms : undefined,
      phonebook: COMMAND_CODES.phonebook in functions ? COMMAND_CODES.phonebook : undefined,
      quietTimes: COMMAND_CODES.quietTimes in functions ? COMMAND_CODES.quietTimes : undefined,
      languageTimezone: COMMAND_CODES.languageTimezone in functions ? COMMAND_CODES.languageTimezone : undefined,
      intercom: COMMAND_CODES.intercom in functions ? COMMAND_CODES.intercom : undefined,
      changePassword: COMMAND_CODES.changePassword in functions ? COMMAND_CODES.changePassword : undefined,
      remoteShutdown: COMMAND_CODES.remoteShutdown in functions ? COMMAND_CODES.remoteShutdown : undefined,
      factoryReset: COMMAND_CODES.factoryReset in functions ? COMMAND_CODES.factoryReset : undefined,
      whitelistPrimary: COMMAND_CODES.whitelistPrimary in functions ? COMMAND_CODES.whitelistPrimary : undefined,
      whitelistSecondary: COMMAND_CODES.whitelistSecondary in functions ? COMMAND_CODES.whitelistSecondary : undefined,
      gpsInterval,
      stepCounter,
      profileMode,
    },
    supportFlags: {
      canFindDevice: COMMAND_CODES.findDevice in functions,
      canSetProfileMode: Boolean(profileMode),
      canManageWhitelist:
        COMMAND_CODES.whitelistPrimary in functions || COMMAND_CODES.whitelistSecondary in functions,
      canManagePhonebook: COMMAND_CODES.phonebook in functions,
      canManageQuietTimes: COMMAND_CODES.quietTimes in functions,
      canManageAlarms: COMMAND_CODES.alarms in functions,
      canSetGpsInterval: Boolean(gpsInterval),
      canToggleStepCounter: Boolean(stepCounter),
      canIntercom: COMMAND_CODES.intercom in functions,
      canChangePassword: COMMAND_CODES.changePassword in functions,
      canRemoteShutdown: COMMAND_CODES.remoteShutdown in functions,
      canFactoryReset: COMMAND_CODES.factoryReset in functions,
    },
  };
}

export function mapModelName(modelId: number | null, explicitName: string | null): string | null {
  if (explicitName) {
    return explicitName;
  }

  if (modelId === 27) {
    return "Connect MOVE";
  }

  if (modelId === 77) {
    return "Connect UP";
  }

  return null;
}
