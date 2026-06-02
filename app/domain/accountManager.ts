import { EventEmitter } from "node:events";

import { COMMAND_CODES } from "./commands";
import { AuthenticationError, ParseError } from "./errors";
import { normalizeTrackerPayload } from "./normalize";
import type { DebugContext } from "../infra/debugLogger";
import { One2TrackClient } from "../infra/one2trackClient";
import type {
  AccountCredentials,
  AccountDiagnostics,
  PhonebookContact,
  QuietTimeWindow,
  RawDevicePageState,
  RawTrackerDevice,
  TrackerCapabilityProfile,
  TrackerDiagnostics,
  TrackerSettingsCache,
  TrackerSnapshot,
  TrackerUpdateEvent,
} from "./types";

type DebugReporter = (source: string, message: string, data?: unknown, context?: DebugContext) => void;

type HomeySettingsHost = {
  settings: {
    set: (key: string, value: unknown) => void;
    get: (key: string) => unknown;
  };
};

type PersistedAccount = AccountCredentials;

type PersistedTrackerState = {
  capabilityProfiles: Record<string, TrackerCapabilityProfile>;
  settingsCache: Record<string, TrackerSettingsCache>;
};

type AccountRecord = {
  accountId: string;
  username: string;
  password: string;
  key: string;
  client: One2TrackClient;
  deviceIds: Set<string>;
  snapshots: Map<string, TrackerSnapshot>;
  rawDevices: Map<string, RawTrackerDevice>;
  rawHtmlState: Map<string, RawDevicePageState>;
  capabilityProfiles: Map<string, TrackerCapabilityProfile>;
  settingsCache: Map<string, TrackerSettingsCache>;
  lastSuccessfulSyncAt: string | null;
  lastError: string | null;
  pollTimer: NodeJS.Timeout | null;
  refreshInFlight: Promise<void> | null;
};

type ManagerEvents = {
  snapshot: [TrackerUpdateEvent];
  account_error: [AccountDiagnostics];
  account_recovered: [AccountDiagnostics];
};

const ACCOUNT_SETTINGS_KEY = "accounts";
const TRACKER_STATE_SETTINGS_KEY = "tracker_state";
const POLL_INTERVAL_MS = 60_000;

function createAccountKey(accountId: string, username: string): string {
  return `${accountId}::${username.trim().toLowerCase()}`;
}

function createEmptySettingsCache(): TrackerSettingsCache {
  return {
    phonebook: [],
    whitelist: [],
    alarms: [],
    quietTimes: [],
    synced: false,
  };
}

function sanitizePhonebook(values: string[]): PhonebookContact[] {
  const contacts: PhonebookContact[] = [];
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index]?.trim() ?? "";
    const number = values[index + 1]?.trim() ?? "";
    if (name || number) {
      contacts.push({ name, number });
    }
  }
  return contacts;
}

function sanitizeWhitelist(values: string[]): string[] {
  return values.map((value) => value.trim()).filter(Boolean);
}

function sanitizeAlarms(values: string[]): string[] {
  return values.filter((value) => /^\d{2}:\d{2}-/.test(value));
}

function sanitizeQuietTimes(values: string[]): QuietTimeWindow[] {
  return values
    .map((value) => value.trim())
    .filter(Boolean)
    .flatMap((value) => {
      const parts = value.split(",");
      if (parts.length < 3) {
        return [];
      }

      const start = parts[1];
      const end = parts[2];
      if (!/^\d{4}$/.test(start) || !/^\d{4}$/.test(end)) {
        return [];
      }

      return [
        {
          start: `${start.slice(0, 2)}:${start.slice(2)}`,
          end: `${end.slice(0, 2)}:${end.slice(2)}`,
        },
      ];
    });
}

export class AccountManager extends EventEmitter<ManagerEvents> {
  private readonly accounts = new Map<string, AccountRecord>();
  private readonly persistedState: PersistedTrackerState;

  constructor(
    private readonly homey: HomeySettingsHost,
    private readonly logger: DebugReporter,
    private readonly errorLogger: DebugReporter,
  ) {
    super();
    this.persistedState = (this.homey.settings.get(TRACKER_STATE_SETTINGS_KEY) as PersistedTrackerState | undefined) ?? {
      capabilityProfiles: {},
      settingsCache: {},
    };
  }

  async registerDevice(deviceId: string, credentials: AccountCredentials): Promise<string> {
    const key = createAccountKey(credentials.accountId, credentials.username);
    let record = this.accounts.get(key);

    if (!record) {
      record = this.createRecord(credentials);
      this.accounts.set(key, record);
    } else {
      record.client.updateCredentials(credentials);
      record.password = credentials.password;
    }

    record.deviceIds.add(deviceId);
    this.persistAccounts();
    this.ensurePolling(record);
    this.logger("account-manager", "Registered device for account polling", {
      deviceId,
      accountId: record.accountId,
      username: record.username,
      trackedDevices: record.deviceIds.size,
    }, {
      accountId: record.accountId,
      username: record.username,
    });

    try {
      await this.refreshAccount(record.accountId, record.username);
    } catch (error) {
      this.errorLogger("account-manager", "Initial refresh failed", error, {
        accountId: record.accountId,
        username: record.username,
      });
    }

    return key;
  }

  async unregisterDevice(deviceId: string): Promise<void> {
    for (const [key, record] of this.accounts.entries()) {
      if (!record.deviceIds.has(deviceId)) {
        continue;
      }

      record.deviceIds.delete(deviceId);
      this.logger("account-manager", "Unregistered device from account polling", {
        deviceId,
        accountId: record.accountId,
        trackedDevices: record.deviceIds.size,
      }, {
        accountId: record.accountId,
        username: record.username,
      });

      if (record.deviceIds.size === 0) {
        if (record.pollTimer) {
          clearInterval(record.pollTimer);
        }
        this.accounts.delete(key);
      }

      this.persistAccounts();
      return;
    }
  }

  async replaceDeviceAccount(deviceId: string, credentials: AccountCredentials): Promise<string> {
    await this.unregisterDevice(deviceId);
    return this.registerDevice(deviceId, credentials);
  }

  getSnapshot(accountId: string, username: string, trackerUuid: string): TrackerSnapshot | null {
    const record = this.accounts.get(createAccountKey(accountId, username));
    return record?.snapshots.get(trackerUuid) ?? null;
  }

  getDiagnostics(accountId: string, username: string): AccountDiagnostics | null {
    const record = this.accounts.get(createAccountKey(accountId, username));
    if (!record) {
      return null;
    }

    return {
      accountId: record.accountId,
      lastSuccessfulSyncAt: record.lastSuccessfulSyncAt,
      lastError: record.lastError,
      trackerCount: record.snapshots.size,
    };
  }

  getCapabilityProfile(accountId: string, username: string, trackerUuid: string): TrackerCapabilityProfile | null {
    const record = this.getRecord(accountId, username);
    return record.capabilityProfiles.get(trackerUuid) ?? null;
  }

  getSettingsCache(accountId: string, username: string, trackerUuid: string): TrackerSettingsCache | null {
    const record = this.getRecord(accountId, username);
    return record.settingsCache.get(trackerUuid) ?? null;
  }

  supportsCommand(accountId: string, username: string, trackerUuid: string, commandCode: string): boolean {
    const profile = this.getCapabilityProfile(accountId, username, trackerUuid);
    return Boolean(profile?.functions[commandCode]);
  }

  async refreshAccount(accountId: string, username: string): Promise<void> {
    const record = this.accounts.get(createAccountKey(accountId, username));
    if (!record) {
      throw new AuthenticationError(`Unknown One2Track account ${accountId}`);
    }

    if (record.refreshInFlight) {
      this.logger("account-manager", "Refresh already in flight, waiting", undefined, {
        accountId,
        username,
      });
      await record.refreshInFlight;
      return;
    }

    this.logger("account-manager", "Refreshing account", undefined, {
      accountId,
      username,
    });
    record.refreshInFlight = this.doRefresh(record).finally(() => {
      record.refreshInFlight = null;
    });

    await record.refreshInFlight;
  }

  async refreshSettingsCache(accountId: string, username: string, trackerUuid: string): Promise<TrackerSettingsCache> {
    const record = this.getRecord(accountId, username);
    const profile = await this.ensureCapabilityProfile(record, trackerUuid);
    const cache = record.settingsCache.get(trackerUuid) ?? createEmptySettingsCache();
    this.logger("account-manager", "Refreshing settings cache", {
      trackerUuid,
      supportedCodes: profile.codes,
    }, {
      accountId,
      username,
      trackerUuid,
    });

    if (profile.codes.phonebook) {
      cache.phonebook = sanitizePhonebook(await record.client.fetchFormValues(trackerUuid, profile.codes.phonebook));
    }

    if (profile.codes.whitelistPrimary) {
      const primary = await record.client.fetchFormValues(trackerUuid, profile.codes.whitelistPrimary);
      const secondary = profile.codes.whitelistSecondary
        ? await record.client.fetchFormValues(trackerUuid, profile.codes.whitelistSecondary)
        : [];
      cache.whitelist = sanitizeWhitelist([...primary, ...secondary]);
    }

    if (profile.codes.alarms) {
      cache.alarms = sanitizeAlarms(await record.client.fetchFormValues(trackerUuid, profile.codes.alarms));
    }

    if (profile.codes.quietTimes) {
      cache.quietTimes = sanitizeQuietTimes(await record.client.fetchFormValues(trackerUuid, profile.codes.quietTimes));
    }

    cache.synced = true;
    record.settingsCache.set(trackerUuid, cache);
    this.persistTrackerState(record);
    this.logger("account-manager", "Refreshed settings cache", cache, {
      accountId,
      username,
      trackerUuid,
    });
    return cache;
  }

  async sendMessage(accountId: string, username: string, trackerUuid: string, message: string): Promise<void> {
    const record = this.getRecord(accountId, username);
    this.logger("account-manager", "Sending tracker message", {
      trackerUuid,
      message,
    }, {
      accountId,
      username,
      trackerUuid,
    });
    await record.client.sendMessage(trackerUuid, message);
  }

  async forceUpdate(accountId: string, username: string, trackerUuid: string): Promise<void> {
    const record = this.getRecord(accountId, username);
    this.logger("account-manager", "Requesting tracker refresh", {
      trackerUuid,
    }, {
      accountId,
      username,
      trackerUuid,
    });
    await record.client.forceUpdate(trackerUuid);
  }

  async findDevice(accountId: string, username: string, trackerUuid: string): Promise<void> {
    const record = this.getRecord(accountId, username);
    this.logger("account-manager", "Requesting find-device command", {
      trackerUuid,
    }, {
      accountId,
      username,
      trackerUuid,
    });
    await record.client.findDevice(trackerUuid);
  }

  async sendCommand(
    accountId: string,
    username: string,
    trackerUuid: string,
    commandCode: string,
    values: string[] = [],
  ): Promise<void> {
    const record = this.getRecord(accountId, username);
    this.logger("account-manager", "Sending command", {
      trackerUuid,
      commandCode,
      values,
    }, {
      accountId,
      username,
      trackerUuid,
    });
    await record.client.sendCommand(trackerUuid, commandCode, values);
  }

  async getRawDiagnostics(accountId: string, username: string, trackerUuid: string): Promise<TrackerDiagnostics> {
    const record = this.getRecord(accountId, username);
    return record.client.getRawDeviceData(
      trackerUuid,
      record.settingsCache.get(trackerUuid) ?? null,
      record.capabilityProfiles.get(trackerUuid) ?? null,
    );
  }

  updateSettingsCache(
    accountId: string,
    username: string,
    trackerUuid: string,
    updater: (current: TrackerSettingsCache) => TrackerSettingsCache,
  ): TrackerSettingsCache {
    const record = this.getRecord(accountId, username);
    const next = updater(record.settingsCache.get(trackerUuid) ?? createEmptySettingsCache());
    next.synced = true;
    record.settingsCache.set(trackerUuid, next);
    this.persistTrackerState(record);
    this.logger("account-manager", "Updated local settings cache", next, {
      accountId,
      username,
      trackerUuid,
    });
    return next;
  }

  private async doRefresh(record: AccountRecord): Promise<void> {
    try {
      const rawDevices = await record.client.refreshDeviceList();
      this.logger("account-manager", "Fetched device list", {
        count: rawDevices.length,
        trackerUuids: rawDevices.map((device) => device.uuid),
      }, {
        accountId: record.accountId,
        username: record.username,
      });

      for (const rawDevice of rawDevices) {
        record.rawDevices.set(rawDevice.uuid, rawDevice);

        const [rawHtmlState, profile] = await Promise.all([
          record.client.fetchDeviceState(rawDevice.uuid),
          this.ensureCapabilityProfile(record, rawDevice.uuid),
        ]);

        if (rawHtmlState) {
          record.rawHtmlState.set(rawDevice.uuid, rawHtmlState);
        }

        if (!(record.settingsCache.get(rawDevice.uuid)?.synced)) {
          try {
            await this.refreshSettingsCache(record.accountId, record.username, rawDevice.uuid);
          } catch (error) {
            this.errorLogger("account-manager", "Could not sync settings cache", error, {
              accountId: record.accountId,
              username: record.username,
              trackerUuid: rawDevice.uuid,
              deviceName: rawDevice.name,
            });
          }
        }

        const snapshot = normalizeTrackerPayload(
          rawDevice,
          rawHtmlState,
          record.settingsCache.get(rawDevice.uuid) ?? createEmptySettingsCache(),
          profile,
        );

        const previousSnapshot = record.snapshots.get(snapshot.trackerUuid) ?? null;
        record.snapshots.set(snapshot.trackerUuid, snapshot);
        this.logger("account-manager", "Normalized tracker snapshot", {
          name: snapshot.name,
          status: snapshot.status,
          latitude: snapshot.latitude,
          longitude: snapshot.longitude,
          batteryPercentage: snapshot.batteryPercentage,
          lastLocationUpdate: snapshot.lastLocationUpdate,
        }, {
          accountId: record.accountId,
          username: record.username,
          trackerUuid: snapshot.trackerUuid,
          deviceName: snapshot.name,
        });
        this.emit("snapshot", {
          accountKey: record.key,
          trackerUuid: snapshot.trackerUuid,
          snapshot,
          previousSnapshot,
        });
      }

      const wasErroring = Boolean(record.lastError);
      record.lastSuccessfulSyncAt = new Date().toISOString();
      record.lastError = null;

      if (wasErroring) {
        this.logger("account-manager", "Account recovered after previous error", {
          trackerCount: record.snapshots.size,
          lastSuccessfulSyncAt: record.lastSuccessfulSyncAt,
        }, {
          accountId: record.accountId,
          username: record.username,
        });
        this.emit("account_recovered", {
          accountId: record.accountId,
          lastSuccessfulSyncAt: record.lastSuccessfulSyncAt,
          lastError: record.lastError,
          trackerCount: record.snapshots.size,
        });
      }
    } catch (error) {
      record.lastError = error instanceof Error ? error.message : String(error);
      this.errorLogger("account-manager", "Refresh failed", error, {
        accountId: record.accountId,
        username: record.username,
      });
      this.emit("account_error", {
        accountId: record.accountId,
        lastSuccessfulSyncAt: record.lastSuccessfulSyncAt,
        lastError: record.lastError,
        trackerCount: record.snapshots.size,
      });
      throw error;
    }
  }

  private getRecord(accountId: string, username: string): AccountRecord {
    const record = this.accounts.get(createAccountKey(accountId, username));
    if (!record) {
      throw new AuthenticationError(`Unknown One2Track account ${accountId}`);
    }
    return record;
  }

  private createRecord(credentials: AccountCredentials): AccountRecord {
    const key = createAccountKey(credentials.accountId, credentials.username);
    const savedProfiles = this.persistedState.capabilityProfiles;
    const savedSettingsCache = this.persistedState.settingsCache;

    return {
      accountId: credentials.accountId,
      username: credentials.username,
      password: credentials.password,
      key,
      client: new One2TrackClient(credentials, this.logger, this.errorLogger),
      deviceIds: new Set<string>(),
      snapshots: new Map<string, TrackerSnapshot>(),
      rawDevices: new Map<string, RawTrackerDevice>(),
      rawHtmlState: new Map<string, RawDevicePageState>(),
      capabilityProfiles: new Map(
        Object.entries(savedProfiles)
          .filter(([trackerKey]) => trackerKey.startsWith(`${credentials.accountId}:`))
          .map(([trackerKey, value]) => [trackerKey.split(":").slice(1).join(":"), value]),
      ),
      settingsCache: new Map(
        Object.entries(savedSettingsCache)
          .filter(([trackerKey]) => trackerKey.startsWith(`${credentials.accountId}:`))
          .map(([trackerKey, value]) => [trackerKey.split(":").slice(1).join(":"), value]),
      ),
      lastSuccessfulSyncAt: null,
      lastError: null,
      pollTimer: null,
      refreshInFlight: null,
    };
  }

  private async ensureCapabilityProfile(record: AccountRecord, trackerUuid: string): Promise<TrackerCapabilityProfile> {
    const existing = record.capabilityProfiles.get(trackerUuid);
    if (existing) {
      return existing;
    }

    this.logger("account-manager", "Discovering capability profile", {
      trackerUuid,
    }, {
      accountId: record.accountId,
      username: record.username,
      trackerUuid,
    });
    const profile = await record.client.discoverCapabilityProfile(trackerUuid);
    record.capabilityProfiles.set(trackerUuid, profile);
    this.persistTrackerState(record);
    this.logger("account-manager", "Discovered capability profile", profile, {
      accountId: record.accountId,
      username: record.username,
      trackerUuid,
    });
    return profile;
  }

  private ensurePolling(record: AccountRecord): void {
    if (record.pollTimer) {
      return;
    }

    record.pollTimer = setInterval(() => {
      void this.refreshAccount(record.accountId, record.username).catch((error) => {
        this.errorLogger("account-manager", "Scheduled refresh failed", error, {
          accountId: record.accountId,
          username: record.username,
        });
      });
    }, POLL_INTERVAL_MS);
  }

  private persistAccounts(): void {
    const persistedAccounts: Record<string, PersistedAccount> = {};
    for (const [key, record] of this.accounts.entries()) {
      if (record.deviceIds.size === 0) {
        continue;
      }

      persistedAccounts[key] = {
        accountId: record.accountId,
        username: record.username,
        password: record.password,
      };
    }

    this.homey.settings.set(ACCOUNT_SETTINGS_KEY, persistedAccounts);
  }

  private persistTrackerState(record: AccountRecord): void {
    for (const [trackerUuid, profile] of record.capabilityProfiles.entries()) {
      this.persistedState.capabilityProfiles[`${record.accountId}:${trackerUuid}`] = profile;
    }

    for (const [trackerUuid, cache] of record.settingsCache.entries()) {
      this.persistedState.settingsCache[`${record.accountId}:${trackerUuid}`] = cache;
    }

    this.homey.settings.set(TRACKER_STATE_SETTINGS_KEY, this.persistedState);
  }
}
