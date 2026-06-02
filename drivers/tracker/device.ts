import Homey from "homey";

import type One2TrackApp from "../../app";
import { detectSnapshotChanges } from "../../app/domain/changeDetector";
import { COMMAND_CODES } from "../../app/domain/commands";
import { AuthenticationError, ParseError } from "../../app/domain/errors";
import {
  calculateDistanceMeters,
  getLocationAgeMinutes,
  isSnapshotStationary,
} from "../../app/domain/flowMetrics";
import { inferBooleanCommandValue, inferCheckedCommandValue } from "../../app/domain/normalize";
import type {
  AccountDiagnostics,
  DeviceStoreData,
  PhonebookContact,
  QuietTimeWindow,
  TrackerCapabilityProfile,
  TrackerDiagnostics,
  TrackerSettingsCache,
  TrackerSnapshot,
  TrackerStatus,
} from "../../app/domain/types";

type CapabilityKey =
  | "measure_battery"
  | "one2track_status"
  | "alarm_tumble"
  | "alarm_offline"
  | "measure_speed"
  | "measure_altitude"
  | "measure_signal_strength"
  | "measure_satellites"
  | "measure_gps_accuracy"
  | "measure_steps"
  | "meter_sim_balance"
  | "one2track_address"
  | "measure_heading"
  | "meter_phonebook_count"
  | "meter_whitelist_count"
  | "button_find_device"
  | "one2track_gps_interval"
  | "one2track_profile_mode"
  | "one2track_step_counter_enabled";

type SnapshotEvent = {
  accountKey: string;
  trackerUuid: string;
  snapshot: TrackerSnapshot;
  previousSnapshot: TrackerSnapshot | null;
};

class One2TrackDevice extends Homey.Device {
  private appInstance!: One2TrackApp;
  private accountId!: string;
  private username!: string;
  private password!: string;
  private trackerUuid!: string;
  private previousSnapshot: TrackerSnapshot | null = null;
  private lastObservedAtMs: number | null = null;
  private stationarySinceMs: number | null = null;
  private readonly registeredDynamicListeners = new Set<string>();

  private readonly onSnapshot = async (event: SnapshotEvent): Promise<void> => {
    if (event.trackerUuid !== this.trackerUuid) {
      return;
    }

    this.appInstance.debug("snapshot", "Received snapshot event", {
      trackerUuid: event.trackerUuid,
      hasPreviousSnapshot: Boolean(event.previousSnapshot),
    }, this.getDebugContext());
    await this.applySnapshot(event.snapshot, event.previousSnapshot);
  };

  private readonly onAccountError = async (diagnostics: AccountDiagnostics): Promise<void> => {
    if (diagnostics.accountId !== this.accountId) {
      return;
    }

    this.appInstance.debugError("device", "Account error received", diagnostics, this.getDebugContext());
    await this.updateDiagnosticSettings(diagnostics);
    await this.setUnavailable(diagnostics.lastError ?? "One2Track account unavailable");
  };

  private readonly onAccountRecovered = async (diagnostics: AccountDiagnostics): Promise<void> => {
    if (diagnostics.accountId !== this.accountId) {
      return;
    }

    this.appInstance.debug("device", "Account recovered", diagnostics, this.getDebugContext());
    await this.updateDiagnosticSettings(diagnostics);
    await this.setAvailable();
  };

  async onInit(): Promise<void> {
    this.appInstance = this.homey.app as One2TrackApp;

    const store = this.getStore() as Partial<DeviceStoreData>;
    this.accountId = store.accountId ?? "";
    this.username = store.username ?? "";
    this.password = store.password ?? "";
    this.trackerUuid = store.trackerUuid ?? "";

    if (!this.accountId || !this.username || !this.password || !this.trackerUuid) {
      throw new AuthenticationError("Device store misses One2Track credentials");
    }

    this.appInstance.debug("device", "Initializing tracker device", {
      accountId: this.accountId,
      trackerUuid: this.trackerUuid,
    }, {
      accountId: this.accountId,
      username: this.username,
      trackerUuid: this.trackerUuid,
      deviceName: this.getName(),
    });

    await this.appInstance.accountManager.registerDevice(this.getDeviceId(), {
      accountId: this.accountId,
      username: this.username,
      password: this.password,
    });

    this.appInstance.accountManager.on("snapshot", this.onSnapshot);
    this.appInstance.accountManager.on("account_error", this.onAccountError);
    this.appInstance.accountManager.on("account_recovered", this.onAccountRecovered);

    const diagnostics = this.appInstance.accountManager.getDiagnostics(this.accountId, this.username);
    if (diagnostics) {
      await this.updateDiagnosticSettings(diagnostics);
    }

    const snapshot = this.appInstance.accountManager.getSnapshot(this.accountId, this.username, this.trackerUuid);
    if (snapshot) {
      await this.applySnapshot(snapshot, null);
    } else {
      await this.setUnavailable("Waiting for first One2Track update");
    }
  }

  async onDeleted(): Promise<void> {
    this.appInstance.debug("device", "Deleting tracker device", undefined, this.getDebugContext());
    this.appInstance.accountManager.off("snapshot", this.onSnapshot);
    this.appInstance.accountManager.off("account_error", this.onAccountError);
    this.appInstance.accountManager.off("account_recovered", this.onAccountRecovered);
    await this.appInstance.accountManager.unregisterDevice(this.getDeviceId());
  }

  async onSettings({
    oldSettings,
    newSettings,
    changedKeys,
  }: {
    oldSettings: Record<string, unknown>;
    newSettings: Record<string, unknown>;
    changedKeys: string[];
  }): Promise<string | void> {
    this.appInstance.debug("device-settings", "Device settings updated", {
      changedKeys,
      oldSettings,
      newSettings,
    }, this.getDebugContext());
  }

  async sendMessage(message: string): Promise<void> {
    this.appInstance.debug("device-command", "sendMessage requested", { message }, this.getDebugContext());
    await this.appInstance.accountManager.sendMessage(this.accountId, this.username, this.trackerUuid, message);
  }

  async forceUpdate(): Promise<void> {
    this.appInstance.debug("device-command", "forceUpdate requested", undefined, this.getDebugContext());
    await this.appInstance.accountManager.forceUpdate(this.accountId, this.username, this.trackerUuid);
  }

  async findDevice(): Promise<void> {
    this.requireProfileFlag((profile) => profile.supportFlags.canFindDevice, "Find device is unavailable");
    this.appInstance.debug("device-command", "findDevice requested", undefined, this.getDebugContext());
    await this.appInstance.accountManager.findDevice(this.accountId, this.username, this.trackerUuid);
  }

  async setGpsInterval(value: string): Promise<void> {
    const profile = this.requireProfileFlag((item) => item.supportFlags.canSetGpsInterval, "GPS interval is unavailable");
    const code = profile.codes.gpsInterval;
    if (!code) {
      throw new ParseError("Missing GPS interval command code");
    }

    await this.appInstance.accountManager.sendCommand(this.accountId, this.username, this.trackerUuid, code, [value]);
  }

  async setProfileMode(value: string): Promise<void> {
    const profile = this.requireProfileFlag((item) => item.supportFlags.canSetProfileMode, "Profile mode is unavailable");
    const code = profile.codes.profileMode;
    if (!code) {
      throw new ParseError("Missing profile mode command code");
    }

    await this.appInstance.accountManager.sendCommand(this.accountId, this.username, this.trackerUuid, code, [value]);
  }

  async getGpsIntervalOptions(): Promise<Array<{ id: string; name: string; description: string }>> {
    const profile = this.requireProfileFlag((item) => item.supportFlags.canSetGpsInterval, "GPS interval is unavailable");
    const code = profile.codes.gpsInterval;
    if (!code) {
      throw new ParseError("Missing GPS interval command code");
    }

    return (profile.options[code] ?? []).map((option) => ({
      id: option.value,
      name: option.label,
      description: option.checked ? "Current option" : "Available option",
    }));
  }

  async getProfileModeOptions(): Promise<Array<{ id: string; name: string; description: string }>> {
    const profile = this.requireProfileFlag((item) => item.supportFlags.canSetProfileMode, "Profile mode is unavailable");
    const code = profile.codes.profileMode;
    if (!code) {
      throw new ParseError("Missing profile mode command code");
    }

    return (profile.options[code] ?? []).map((option) => ({
      id: option.value,
      name: option.label,
      description: option.checked ? "Current option" : "Available option",
    }));
  }

  async setStepCounterEnabled(enabled: boolean): Promise<void> {
    const profile = this.requireProfileFlag(
      (item) => item.supportFlags.canToggleStepCounter,
      "Step counter toggle is unavailable",
    );
    const code = profile.codes.stepCounter;
    const value = inferBooleanCommandValue(profile, "stepCounter", enabled);

    if (!code || !value) {
      throw new ParseError("Step counter option mapping is unavailable");
    }

    await this.appInstance.accountManager.sendCommand(this.accountId, this.username, this.trackerUuid, code, [value]);
  }

  async setSosNumber(phoneNumber: string): Promise<void> {
    await this.sendCommand(COMMAND_CODES.sosNumber, [phoneNumber]);
  }

  async setAlarms(alarms: string[]): Promise<void> {
    await this.sendCommand(COMMAND_CODES.alarms, alarms);
    this.appInstance.accountManager.updateSettingsCache(this.accountId, this.username, this.trackerUuid, (current) => ({
      ...current,
      alarms,
    }));
  }

  async setQuietTimes(windows: QuietTimeWindow[]): Promise<void> {
    const values = windows.map((window, index) => {
      const start = window.start.replace(":", "");
      const end = window.end.replace(":", "");
      let entry = `1,${start},${end},1`;
      if (index === windows.length - 1) {
        entry += ",1";
      }
      return entry;
    });

    await this.sendCommand(COMMAND_CODES.quietTimes, values);
    this.appInstance.accountManager.updateSettingsCache(this.accountId, this.username, this.trackerUuid, (current) => ({
      ...current,
      quietTimes: windows,
    }));
  }

  async setLanguageTimezone(language: string, utcOffset: string): Promise<void> {
    await this.sendCommand(COMMAND_CODES.languageTimezone, [language, utcOffset]);
  }

  async setPhonebook(contacts: PhonebookContact[]): Promise<void> {
    const values = contacts.flatMap((contact) => [contact.name, contact.number]);
    await this.sendCommand(COMMAND_CODES.phonebook, values);
    this.appInstance.accountManager.updateSettingsCache(this.accountId, this.username, this.trackerUuid, (current) => ({
      ...current,
      phonebook: contacts,
    }));
  }

  async addPhonebookContact(contact: PhonebookContact): Promise<void> {
    const cache = await this.requireSyncedSettings();
    const contacts = cache.phonebook.filter((existing) => existing.name !== contact.name);
    contacts.push(contact);
    await this.setPhonebook(contacts);
  }

  async removePhonebookContact(name: string): Promise<void> {
    const cache = await this.requireSyncedSettings();
    const contacts = cache.phonebook.filter((existing) => existing.name !== name);
    if (contacts.length === cache.phonebook.length) {
      throw new ParseError(`Phonebook contact '${name}' was not found`);
    }

    await this.setPhonebook(contacts);
  }

  async setWhitelist(numbers: string[]): Promise<void> {
    const profile = this.requireProfileFlag((item) => item.supportFlags.canManageWhitelist, "Whitelist is unavailable");
    const primaryCode = profile.codes.whitelistPrimary;
    const secondaryCode = profile.codes.whitelistSecondary;
    if (!primaryCode || !secondaryCode) {
      throw new ParseError("Whitelist command codes are unavailable");
    }

    const padded = [...numbers, ...Array(10).fill("")].slice(0, 10);
    await this.appInstance.accountManager.sendCommand(
      this.accountId,
      this.username,
      this.trackerUuid,
      primaryCode,
      padded.slice(0, 5),
    );
    await this.appInstance.accountManager.sendCommand(
      this.accountId,
      this.username,
      this.trackerUuid,
      secondaryCode,
      padded.slice(5),
    );
    this.appInstance.accountManager.updateSettingsCache(this.accountId, this.username, this.trackerUuid, (current) => ({
      ...current,
      whitelist: numbers,
    }));
  }

  async addWhitelistNumber(phoneNumber: string): Promise<void> {
    const cache = await this.requireSyncedSettings();
    if (cache.whitelist.includes(phoneNumber)) {
      throw new ParseError(`Whitelist already contains '${phoneNumber}'`);
    }
    if (cache.whitelist.length >= 10) {
      throw new ParseError("Whitelist is full");
    }

    await this.setWhitelist([...cache.whitelist, phoneNumber]);
  }

  async removeWhitelistNumber(phoneNumber: string): Promise<void> {
    const cache = await this.requireSyncedSettings();
    if (!cache.whitelist.includes(phoneNumber)) {
      throw new ParseError(`Whitelist number '${phoneNumber}' was not found`);
    }

    await this.setWhitelist(cache.whitelist.filter((value) => value !== phoneNumber));
  }

  async intercom(phoneNumber: string): Promise<void> {
    await this.sendCommand(COMMAND_CODES.intercom, [phoneNumber], (profile) => profile.supportFlags.canIntercom);
  }

  async changePassword(password: string): Promise<void> {
    this.requireDangerousSettingEnabled("allow_password_change", "Password changes are disabled in device settings");
    await this.sendCommand(
      COMMAND_CODES.changePassword,
      [password],
      (profile) => profile.supportFlags.canChangePassword,
    );
  }

  async factoryReset(): Promise<void> {
    this.requireDangerousSettingEnabled("allow_factory_reset", "Factory reset is disabled in device settings");
    await this.sendCommand(
      COMMAND_CODES.factoryReset,
      [],
      (profile) => profile.supportFlags.canFactoryReset,
    );
  }

  async remoteShutdown(): Promise<void> {
    this.requireDangerousSettingEnabled("allow_remote_shutdown", "Remote shutdown is disabled in device settings");
    await this.sendCommand(
      COMMAND_CODES.remoteShutdown,
      [],
      (profile) => profile.supportFlags.canRemoteShutdown,
    );
  }

  async getRawDiagnostics(): Promise<TrackerDiagnostics> {
    return this.appInstance.accountManager.getRawDiagnostics(this.accountId, this.username, this.trackerUuid);
  }

  isOffline(): boolean {
    return this.previousSnapshot?.status === "offline";
  }

  hasStatus(status: TrackerStatus): boolean {
    return this.previousSnapshot?.status === status;
  }

  hasTumbleActive(): boolean {
    return this.previousSnapshot?.tumbleDetected === true;
  }

  hasRecentLocation(minutes: number): boolean {
    const ageMinutes = getLocationAgeMinutes(this.previousSnapshot);
    return ageMinutes !== null && ageMinutes <= minutes;
  }

  hasStaleLocation(minutes: number): boolean {
    const ageMinutes = getLocationAgeMinutes(this.previousSnapshot);
    return ageMinutes !== null && ageMinutes > minutes;
  }

  hasBatteryAtOrBelow(threshold: number): boolean {
    return (this.previousSnapshot?.batteryPercentage ?? Number.POSITIVE_INFINITY) <= threshold;
  }

  hasSimBalanceAtOrBelow(threshold: number): boolean {
    return (this.previousSnapshot?.simBalanceEur ?? Number.POSITIVE_INFINITY) <= threshold;
  }

  hasSpeedAtOrAbove(threshold: number): boolean {
    return (this.previousSnapshot?.speedKmh ?? Number.NEGATIVE_INFINITY) >= threshold;
  }

  hasStepsAtOrAbove(threshold: number): boolean {
    return (this.previousSnapshot?.stepCount ?? Number.NEGATIVE_INFINITY) >= threshold;
  }

  isInsideZone(latitude: number, longitude: number, radiusMeters: number): boolean {
    const distanceMeters = this.getDistanceTo(latitude, longitude);
    return distanceMeters !== null && distanceMeters <= radiusMeters;
  }

  isWithinHomeDistance(radiusMeters: number): boolean {
    const distanceMeters = this.getDistanceToHome();
    return distanceMeters !== null && distanceMeters <= radiusMeters;
  }

  isStationaryFor(minutes: number): boolean {
    const durationMinutes = this.getStationaryDurationMinutes();
    return durationMinutes !== null && durationMinutes >= minutes;
  }

  async updateSharedCredentials(accountId: string, username: string, password: string): Promise<void> {
    this.accountId = accountId;
    this.username = username;
    this.password = password;
    this.appInstance.debug("device", "Updating shared credentials", {
      accountId,
      username,
    }, this.getDebugContext());
    await this.setStoreValue("accountId", accountId);
    await this.setStoreValue("username", username);
    await this.setStoreValue("password", password);
  }

  private async applySnapshot(snapshot: TrackerSnapshot, managerPreviousSnapshot: TrackerSnapshot | null): Promise<void> {
    const effectivePreviousSnapshot = this.previousSnapshot ?? managerPreviousSnapshot;
    const changes = detectSnapshotChanges(snapshot, effectivePreviousSnapshot);
    const observedAtMs = Date.now();
    const previousAgeMinutes = getLocationAgeMinutes(effectivePreviousSnapshot, this.lastObservedAtMs ?? observedAtMs);
    const currentAgeMinutes = getLocationAgeMinutes(snapshot, observedAtMs);
    const previousStationaryMinutes =
      this.stationarySinceMs !== null && this.lastObservedAtMs !== null
        ? (this.lastObservedAtMs - this.stationarySinceMs) / 60_000
        : null;

    if (isSnapshotStationary(snapshot)) {
      this.stationarySinceMs =
        isSnapshotStationary(effectivePreviousSnapshot) && this.stationarySinceMs !== null
          ? this.stationarySinceMs
          : observedAtMs;
    } else {
      this.stationarySinceMs = null;
    }

    const currentStationaryMinutes =
      this.stationarySinceMs !== null ? Math.max(0, (observedAtMs - this.stationarySinceMs) / 60_000) : null;

    this.appInstance.debug("snapshot", "Applying tracker snapshot", {
      changes,
      status: snapshot.status,
      latitude: snapshot.latitude,
      longitude: snapshot.longitude,
      batteryPercentage: snapshot.batteryPercentage,
      previousAgeMinutes,
      currentAgeMinutes,
      previousStationaryMinutes,
      currentStationaryMinutes,
    }, {
      ...this.getDebugContext(),
      deviceName: snapshot.name,
    });

    await this.syncDynamicCapabilities(snapshot);
    await this.setAvailable();
    await this.setCapabilitySafely("measure_battery", snapshot.batteryPercentage ?? 0);
    await this.setCapabilitySafely("one2track_status", snapshot.status);
    await this.setCapabilitySafely("alarm_tumble", snapshot.tumbleDetected);
    await this.setCapabilitySafely("alarm_offline", snapshot.status === "offline");
    await this.setCapabilitySafely("measure_speed", snapshot.speedKmh ?? 0);
    await this.setCapabilitySafely("measure_altitude", snapshot.altitudeMeters ?? 0);
    await this.setCapabilitySafely("measure_signal_strength", snapshot.signalStrength ?? 0);
    await this.setCapabilitySafely("measure_satellites", snapshot.satelliteCount ?? 0);
    await this.setCapabilitySafely("measure_gps_accuracy", snapshot.accuracyMeters ?? 0);
    await this.setCapabilitySafely("measure_steps", snapshot.stepCount ?? 0);
    await this.setCapabilitySafely("meter_sim_balance", snapshot.simBalanceEur ?? 0);
    await this.setCapabilitySafely("one2track_address", snapshot.address ?? "");

    if (this.hasCapability("measure_heading")) {
      await this.setCapabilitySafely("measure_heading", snapshot.headingDegrees ?? 0);
    }

    if (this.hasCapability("meter_phonebook_count")) {
      await this.setCapabilitySafely("meter_phonebook_count", snapshot.phonebookCount ?? 0);
    }

    if (this.hasCapability("meter_whitelist_count")) {
      await this.setCapabilitySafely("meter_whitelist_count", snapshot.whitelistCount ?? 0);
    }

    if (this.hasCapability("one2track_gps_interval")) {
      await this.setCapabilitySafely(
        "one2track_gps_interval",
        snapshot.profile?.codes.gpsInterval
          ? snapshot.profile.options[snapshot.profile.codes.gpsInterval]?.find((option) => option.checked)?.value ?? ""
          : "",
      );
    }

    if (this.hasCapability("one2track_profile_mode")) {
      await this.setCapabilitySafely(
        "one2track_profile_mode",
        snapshot.profile?.codes.profileMode
          ? snapshot.profile.options[snapshot.profile.codes.profileMode]?.find((option) => option.checked)?.value ?? ""
          : "",
      );
    }

    if (this.hasCapability("one2track_step_counter_enabled")) {
      const selectedStepCounterValue = inferCheckedCommandValue(snapshot.profile, "stepCounter");
      const enabledStepCounterValue = inferBooleanCommandValue(snapshot.profile, "stepCounter", true);
      await this.setCapabilitySafely(
        "one2track_step_counter_enabled",
        Boolean(selectedStepCounterValue && enabledStepCounterValue && selectedStepCounterValue === enabledStepCounterValue),
      );
    }

    const diagnostics = this.appInstance.accountManager.getDiagnostics(this.accountId, this.username);
    await this.updateSnapshotSettings(snapshot, diagnostics);

    this.previousSnapshot = snapshot;
    this.lastObservedAtMs = observedAtMs;

    if (changes.locationChanged) {
      await this.appInstance.triggerLocationUpdated(this, snapshot);
    }

    if (changes.statusChanged) {
      await this.appInstance.triggerStatusChanged(this, snapshot);
    }

    if (changes.wentOffline) {
      await this.appInstance.triggerDeviceWentOffline(this, snapshot);
    }

    if (changes.cameOnline) {
      await this.appInstance.triggerDeviceCameOnline(this, snapshot);
    }

    if (changes.tumbleDetected) {
      await this.appInstance.triggerTumbleDetected(this, snapshot);
    }

    if (changes.tumbleCleared) {
      await this.appInstance.triggerTumbleCleared(this, snapshot);
    }

    if (changes.batteryChanged) {
      await this.appInstance.triggerBatteryBelowThreshold(this, snapshot, effectivePreviousSnapshot);
    }

    if (changes.simBalanceChanged) {
      await this.appInstance.triggerSimBalanceBelowThreshold(this, snapshot, effectivePreviousSnapshot);
    }

    if (changes.statusChanged) {
      await this.appInstance.triggerStatusBecame(this, snapshot, effectivePreviousSnapshot);
    }

    if (changes.speedChanged) {
      await this.appInstance.triggerSpeedAboveThreshold(this, snapshot, effectivePreviousSnapshot);
    }

    if (changes.stepCountChanged) {
      await this.appInstance.triggerStepsAboveThreshold(this, snapshot, effectivePreviousSnapshot);
    }

    await this.appInstance.triggerLocationBecameStale(this, snapshot, previousAgeMinutes, currentAgeMinutes);
    await this.appInstance.triggerZoneTransitions(this, snapshot, effectivePreviousSnapshot);
    await this.appInstance.triggerHomeDistanceTransitions(this, snapshot, effectivePreviousSnapshot);
    await this.appInstance.triggerStationaryTooLong(this, snapshot, previousStationaryMinutes, currentStationaryMinutes);
  }

  private async syncDynamicCapabilities(snapshot: TrackerSnapshot): Promise<void> {
    const profile = snapshot.profile;
    if (!profile) {
      return;
    }

    this.appInstance.debug("capabilities", "Syncing dynamic capabilities", {
      supportFlags: profile.supportFlags,
    }, {
      ...this.getDebugContext(),
      deviceName: snapshot.name,
      trackerUuid: snapshot.trackerUuid,
    });

    if (snapshot.headingDegrees !== null) {
      await this.ensureCapability("measure_heading");
    }

    if (snapshot.phonebookCount !== null || profile.supportFlags.canManagePhonebook) {
      await this.ensureCapability("meter_phonebook_count");
    }

    if (snapshot.whitelistCount !== null || profile.supportFlags.canManageWhitelist) {
      await this.ensureCapability("meter_whitelist_count");
    }

    if (profile.supportFlags.canFindDevice) {
      await this.ensureCapability("button_find_device");
      await this.registerDynamicListener("button_find_device", async () => this.findDevice());
    }

    if (profile.supportFlags.canSetGpsInterval && profile.codes.gpsInterval) {
      await this.ensureCapability("one2track_gps_interval");
      await this.setCapabilityOptions("one2track_gps_interval", {
        values: this.toCapabilityValues(profile.options[profile.codes.gpsInterval] ?? []),
      });
      await this.registerDynamicListener("one2track_gps_interval", async (value) => {
        await this.setGpsInterval(String(value));
      });
    }

    if (profile.supportFlags.canSetProfileMode && profile.codes.profileMode) {
      await this.ensureCapability("one2track_profile_mode");
      await this.setCapabilityOptions("one2track_profile_mode", {
        values: this.toCapabilityValues(profile.options[profile.codes.profileMode] ?? []),
      });
      await this.registerDynamicListener("one2track_profile_mode", async (value) => {
        await this.setProfileMode(String(value));
      });
    }

    if (profile.supportFlags.canToggleStepCounter && inferBooleanCommandValue(profile, "stepCounter", true)) {
      await this.ensureCapability("one2track_step_counter_enabled");
      await this.registerDynamicListener("one2track_step_counter_enabled", async (value) => {
        await this.setStepCounterEnabled(Boolean(value));
      });
    }
  }

  private async ensureCapability(capability: CapabilityKey): Promise<void> {
    if (!this.hasCapability(capability)) {
      this.appInstance.debug("capabilities", "Adding capability", { capability }, this.getDebugContext());
      await this.addCapability(capability);
    }
  }

  private async registerDynamicListener(
    capability: string,
    listener: (value: unknown) => Promise<void>,
  ): Promise<void> {
    if (this.registeredDynamicListeners.has(capability)) {
      return;
    }

    this.registerCapabilityListener(capability, async (value: unknown) => {
      this.appInstance.debug("capability-listener", "Capability listener invoked", {
        capability,
        value,
      }, this.getDebugContext());
      await listener(value);
    });
    this.registeredDynamicListeners.add(capability);
    this.appInstance.debug("capability-listener", "Capability listener registered", {
      capability,
    }, this.getDebugContext());
  }

  private async setCapabilitySafely(capability: CapabilityKey, value: boolean | number | string): Promise<void> {
    try {
      this.appInstance.debug("capability-update", "Updating capability", {
        capability,
        value,
      }, this.getDebugContext());
      await this.setCapabilityValue(capability, value);
    } catch (error) {
      this.appInstance.debugError("capability-update", "Could not update capability", {
        capability,
        error,
      }, this.getDebugContext());
      this.error(`Could not update capability ${capability}`, error);
    }
  }

  private async updateDiagnosticSettings(diagnostics: AccountDiagnostics): Promise<void> {
    this.appInstance.debug("device-settings", "Updating diagnostic settings", diagnostics, this.getDebugContext());
    await this.setSettings({
      account_id: diagnostics.accountId,
      last_sync_at: diagnostics.lastSuccessfulSyncAt ?? "-",
      last_error: diagnostics.lastError ?? "-",
    });
  }

  private async updateSnapshotSettings(snapshot: TrackerSnapshot, diagnostics: AccountDiagnostics | null): Promise<void> {
    this.appInstance.debug("device-settings", "Updating snapshot settings", {
      snapshot,
      diagnostics,
    }, {
      ...this.getDebugContext(),
      deviceName: snapshot.name,
      trackerUuid: snapshot.trackerUuid,
    });
    await this.setSettings({
      account_id: this.accountId,
      serial_number: snapshot.serialNumber,
      model_name: snapshot.modelName ?? "-",
      manufacturer: snapshot.manufacturer,
      phone_number: snapshot.phoneNumber ?? "-",
      location_type: snapshot.locationType ?? "-",
      phonebook_count: String(snapshot.phonebookCount ?? 0),
      whitelist_count: String(snapshot.whitelistCount ?? 0),
      last_sync_at: diagnostics?.lastSuccessfulSyncAt ?? "-",
      last_location_update: snapshot.lastLocationUpdate ?? "-",
      last_error: diagnostics?.lastError ?? "-",
    });
  }

  private getDistanceTo(latitude: number, longitude: number): number | null {
    return calculateDistanceMeters(this.previousSnapshot?.latitude, this.previousSnapshot?.longitude, latitude, longitude);
  }

  private getDistanceToHome(): number | null {
    const homeLatitude = this.homey.geolocation.getLatitude();
    const homeLongitude = this.homey.geolocation.getLongitude();

    return calculateDistanceMeters(this.previousSnapshot?.latitude, this.previousSnapshot?.longitude, homeLatitude, homeLongitude);
  }

  getDistanceFromSnapshotTo(latitude: number, longitude: number, snapshot: TrackerSnapshot | null): number | null {
    return calculateDistanceMeters(snapshot?.latitude, snapshot?.longitude, latitude, longitude);
  }

  getHomeDistanceFromSnapshot(snapshot: TrackerSnapshot | null): number | null {
    const homeLatitude = this.homey.geolocation.getLatitude();
    const homeLongitude = this.homey.geolocation.getLongitude();

    return calculateDistanceMeters(snapshot?.latitude, snapshot?.longitude, homeLatitude, homeLongitude);
  }

  getStationaryDurationMinutes(): number | null {
    if (this.stationarySinceMs === null) {
      return null;
    }

    return Math.max(0, (Date.now() - this.stationarySinceMs) / 60_000);
  }

  private requireProfileFlag(
    predicate: (profile: TrackerCapabilityProfile) => boolean,
    message: string,
  ): TrackerCapabilityProfile {
    const profile = this.previousSnapshot?.profile;
    if (!profile || !predicate(profile)) {
      throw new ParseError(message);
    }

    return profile;
  }

  private requireDangerousSettingEnabled(settingId: string, message: string): void {
    if (this.getSetting(settingId) !== true) {
      throw new ParseError(message);
    }
  }

  private async requireSyncedSettings(): Promise<TrackerSettingsCache> {
    const current = this.appInstance.accountManager.getSettingsCache(this.accountId, this.username, this.trackerUuid);
    if (current?.synced) {
      this.appInstance.debug("device-settings", "Using cached synced settings", current, this.getDebugContext());
      return current;
    }

    this.appInstance.debug("device-settings", "Refreshing unsynced settings cache", undefined, this.getDebugContext());
    return this.appInstance.accountManager.refreshSettingsCache(this.accountId, this.username, this.trackerUuid);
  }

  private async sendCommand(
    commandCode: string,
    values: string[] = [],
    supportCheck?: (profile: TrackerCapabilityProfile) => boolean,
  ): Promise<void> {
    if (supportCheck) {
      this.requireProfileFlag(supportCheck, `Device does not support command ${commandCode}`);
    }

    this.appInstance.debug("device-command", "sendCommand requested", {
      commandCode,
      values,
    }, this.getDebugContext());
    await this.appInstance.accountManager.sendCommand(
      this.accountId,
      this.username,
      this.trackerUuid,
      commandCode,
      values,
    );
  }

  private toCapabilityValues(options: TrackerCapabilityProfile["options"][string]): Array<{
    id: string;
    title: { en: string; nl: string };
  }> {
    return options.map((option) => ({
      id: option.value,
      title: {
        en: option.label,
        nl: option.label,
      },
    }));
  }

  private getDeviceId(): string {
    return String(this.getData().id);
  }

  private getDebugContext(): {
    accountId: string;
    username: string;
    trackerUuid: string;
    deviceName: string;
  } {
    return {
      accountId: this.accountId,
      username: this.username,
      trackerUuid: this.trackerUuid,
      deviceName: this.getName(),
    };
  }
}

export default One2TrackDevice;
module.exports = One2TrackDevice;
