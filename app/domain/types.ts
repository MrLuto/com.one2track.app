export type TrackerStatus = "gps" | "wifi" | "offline";

export type AccountCredentials = {
  accountId: string;
  username: string;
  password: string;
};

export type DeviceStoreData = AccountCredentials & {
  trackerUuid: string;
  serialNumber: string;
};

export type CommandOption = {
  value: string;
  label: string;
  checked: boolean;
};

export type QuietTimeWindow = {
  start: string;
  end: string;
};

export type PhonebookContact = {
  name: string;
  number: string;
};

export type TrackerSettingsCache = {
  phonebook: PhonebookContact[];
  whitelist: string[];
  alarms: string[];
  quietTimes: QuietTimeWindow[];
  synced: boolean;
};

export type RawTrackerMetaData = {
  tumble?: string;
  steps?: string;
  course?: number | string;
  accuracy_meters?: number;
  accuracy?: string;
};

export type RawTrackerLocation = {
  id?: number;
  last_communication?: string;
  last_location_update?: string;
  address?: string;
  latitude?: string;
  longitude?: string;
  altitude?: string;
  location_type?: string;
  signal_strength?: number;
  satellite_count?: number;
  speed?: string;
  battery_percentage?: number;
  meta_data?: RawTrackerMetaData;
};

export type RawTrackerDevice = {
  id: number;
  serial_number: string;
  name: string;
  phone_number?: string;
  status?: string;
  uuid: string;
  model_id?: number | string;
  model_name?: string;
  manufacturer?: string;
  last_location?: RawTrackerLocation;
  simcard?: {
    balance_cents?: number;
  };
};

export type RawDevicePageState = {
  device?: Record<string, unknown>;
  last_location?: Record<string, unknown>;
};

export type TrackerCapabilityProfile = {
  functions: Record<string, string>;
  options: Record<string, CommandOption[]>;
  discoveredAt: string;
  codes: {
    refreshLocation?: string;
    findDevice?: string;
    sosNumber?: string;
    alarms?: string;
    phonebook?: string;
    quietTimes?: string;
    languageTimezone?: string;
    intercom?: string;
    changePassword?: string;
    remoteShutdown?: string;
    factoryReset?: string;
    whitelistPrimary?: string;
    whitelistSecondary?: string;
    gpsInterval?: string;
    stepCounter?: string;
    profileMode?: string;
  };
  supportFlags: {
    canFindDevice: boolean;
    canSetProfileMode: boolean;
    canManageWhitelist: boolean;
    canManagePhonebook: boolean;
    canManageQuietTimes: boolean;
    canManageAlarms: boolean;
    canSetGpsInterval: boolean;
    canToggleStepCounter: boolean;
    canIntercom: boolean;
    canChangePassword: boolean;
    canRemoteShutdown: boolean;
    canFactoryReset: boolean;
  };
};

export type TrackerSnapshot = {
  id: number;
  trackerUuid: string;
  serialNumber: string;
  name: string;
  phoneNumber: string | null;
  status: TrackerStatus;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  altitudeMeters: number | null;
  signalStrength: number | null;
  satelliteCount: number | null;
  speedKmh: number | null;
  batteryPercentage: number | null;
  tumbleDetected: boolean;
  stepCount: number | null;
  accuracyMeters: number | null;
  headingDegrees: number | null;
  locationType: string | null;
  simBalanceEur: number | null;
  lastCommunication: string | null;
  lastLocationUpdate: string | null;
  modelId: number | null;
  modelName: string | null;
  manufacturer: string;
  phonebookCount: number | null;
  whitelistCount: number | null;
  profile: TrackerCapabilityProfile | null;
};

export type TrackerUpdateEvent = {
  accountKey: string;
  trackerUuid: string;
  snapshot: TrackerSnapshot;
  previousSnapshot: TrackerSnapshot | null;
};

export type TrackerDiagnostics = {
  jsonApi: RawTrackerDevice | null;
  htmlState: RawDevicePageState | null;
  capabilityProfile: TrackerCapabilityProfile | null;
  localSettings: TrackerSettingsCache | null;
};

export type AccountDiagnostics = {
  accountId: string;
  lastSuccessfulSyncAt: string | null;
  lastError: string | null;
  trackerCount: number;
};
