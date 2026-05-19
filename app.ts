import "source-map-support/register";

import Homey from "homey";

import { parseAlarmsInput, parseCsvStrings, parsePhonebookInput, parseQuietTimesInput } from "./app/domain/actionParsers";
import { AccountManager } from "./app/domain/accountManager";
import {
  calculateDistanceMeters,
  crossedAboveThreshold,
  crossedBelowThreshold,
  crossedIntoDistance,
  crossedOutOfDistance,
} from "./app/domain/flowMetrics";
import type { TrackerSnapshot, TrackerStatus } from "./app/domain/types";
import type One2TrackDevice from "./drivers/tracker/device";

type FlowTokenMap = {
  device_name: string;
  status: string;
  battery: number;
  address: string;
  latitude: number;
  longitude: number;
  speed: number;
  accuracy: number;
  satellites: number;
  last_location_update: string;
  model_name: string;
  heading: number;
  phonebook_count: number;
  whitelist_count: number;
  sim_balance: number;
  steps: number;
};

type FlowAutocompleteOption = {
  id: string;
  name: string;
  description?: string;
};

type TriggerState = Record<string, unknown>;

class One2TrackApp extends Homey.App {
  public readonly accountManager = new AccountManager(this.homey, this.log.bind(this));

  private deviceTriggers!: {
    locationUpdated: Homey.FlowCardTriggerDevice;
    statusChanged: Homey.FlowCardTriggerDevice;
    deviceWentOffline: Homey.FlowCardTriggerDevice;
    deviceCameOnline: Homey.FlowCardTriggerDevice;
    tumbleDetected: Homey.FlowCardTriggerDevice;
    tumbleCleared: Homey.FlowCardTriggerDevice;
    batteryBelowThreshold: Homey.FlowCardTriggerDevice;
    simBalanceBelowThreshold: Homey.FlowCardTriggerDevice;
    statusBecame: Homey.FlowCardTriggerDevice;
    speedAboveThreshold: Homey.FlowCardTriggerDevice;
    stepsAboveThreshold: Homey.FlowCardTriggerDevice;
    locationBecameStale: Homey.FlowCardTriggerDevice;
    enteredZone: Homey.FlowCardTriggerDevice;
    leftZone: Homey.FlowCardTriggerDevice;
    cameWithinHomeDistance: Homey.FlowCardTriggerDevice;
    wentBeyondHomeDistance: Homey.FlowCardTriggerDevice;
    stationaryTooLong: Homey.FlowCardTriggerDevice;
    remoteShutdownRequested: Homey.FlowCardTriggerDevice;
  };

  async onInit(): Promise<void> {
    this.registerFlowCards();
    this.log("One2Track app initialized");
  }

  private registerFlowCards(): void {
    this.registerAction("send_message", async (args: { device: One2TrackDevice; message: string }) => {
      await args.device.sendMessage(args.message);
    });

    this.registerAction("force_update", async (args: { device: One2TrackDevice }) => {
      await args.device.forceUpdate();
    });

    this.registerAction("find_device", async (args: { device: One2TrackDevice }) => {
      await args.device.findDevice();
    });

    const gpsIntervalCard = this.homey.flow.getActionCard("set_gps_interval");
    gpsIntervalCard.registerArgumentAutocompleteListener("option", async (_query: string, args: { device: One2TrackDevice }) => {
      return args.device.getGpsIntervalOptions();
    });
    gpsIntervalCard.registerRunListener(async (args: { device: One2TrackDevice; option: FlowAutocompleteOption }) => {
      await args.device.setGpsInterval(this.getAutocompleteId(args.option, "GPS interval"));
      return true;
    });

    const profileModeCard = this.homey.flow.getActionCard("set_profile_mode");
    profileModeCard.registerArgumentAutocompleteListener("option", async (_query: string, args: { device: One2TrackDevice }) => {
      return args.device.getProfileModeOptions();
    });
    profileModeCard.registerRunListener(async (args: { device: One2TrackDevice; option: FlowAutocompleteOption }) => {
      await args.device.setProfileMode(this.getAutocompleteId(args.option, "profile mode"));
      return true;
    });

    this.registerAction("set_sos_number", async (args: { device: One2TrackDevice; phone_number: string }) => {
      await args.device.setSosNumber(args.phone_number);
    });

    this.registerAction("set_language_timezone", async (args: { device: One2TrackDevice; language: string; utc_offset: string }) => {
      await args.device.setLanguageTimezone(args.language, args.utc_offset);
    });

    this.registerAction("set_alarms", async (args: { device: One2TrackDevice; alarms: string }) => {
      await args.device.setAlarms(parseAlarmsInput(args.alarms));
    });

    this.registerAction("set_quiet_times", async (args: { device: One2TrackDevice; windows_json: string }) => {
      await args.device.setQuietTimes(parseQuietTimesInput(args.windows_json));
    });

    this.registerAction("set_phonebook", async (args: { device: One2TrackDevice; contacts_json: string }) => {
      await args.device.setPhonebook(parsePhonebookInput(args.contacts_json));
    });

    this.registerAction("add_phonebook_contact", async (args: { device: One2TrackDevice; name: string; number: string }) => {
      await args.device.addPhonebookContact({
        name: args.name,
        number: args.number,
      });
    });

    this.registerAction("remove_phonebook_contact", async (args: { device: One2TrackDevice; name: string }) => {
      await args.device.removePhonebookContact(args.name);
    });

    this.registerAction("set_whitelist", async (args: { device: One2TrackDevice; phone_numbers: string }) => {
      await args.device.setWhitelist(parseCsvStrings(args.phone_numbers));
    });

    this.registerAction("add_whitelist_number", async (args: { device: One2TrackDevice; phone_number: string }) => {
      await args.device.addWhitelistNumber(args.phone_number);
    });

    this.registerAction("remove_whitelist_number", async (args: { device: One2TrackDevice; phone_number: string }) => {
      await args.device.removeWhitelistNumber(args.phone_number);
    });

    this.registerAction("intercom", async (args: { device: One2TrackDevice; phone_number: string }) => {
      await args.device.intercom(args.phone_number);
    });

    this.registerAction("change_password", async (args: { device: One2TrackDevice; password: string }) => {
      await args.device.changePassword(args.password);
    });

    this.registerAction("factory_reset", async (args: { device: One2TrackDevice }) => {
      await args.device.factoryReset();
    });

    this.registerAction("remote_shutdown", async (args: { device: One2TrackDevice }) => {
      await args.device.remoteShutdown();
      await this.triggerRemoteShutdownRequested(args.device);
    });

    this.registerAction("log_raw_diagnostics", async (args: { device: One2TrackDevice }) => {
      const diagnostics = await args.device.getRawDiagnostics();
      this.log("[one2track][diagnostics]", JSON.stringify(diagnostics));
    });

    const isOfflineCard = this.homey.flow.getConditionCard("is_offline");
    isOfflineCard.registerRunListener(async (args: { device: One2TrackDevice }) => args.device.isOffline());

    const statusIsCard = this.homey.flow.getConditionCard("status_is");
    statusIsCard.registerRunListener(async (args: { device: One2TrackDevice; status: TrackerStatus }) => {
      return args.device.hasStatus(args.status);
    });

    const tumbleIsActiveCard = this.homey.flow.getConditionCard("tumble_is_active");
    tumbleIsActiveCard.registerRunListener(async (args: { device: One2TrackDevice }) => args.device.hasTumbleActive());

    const hasRecentLocationCard = this.homey.flow.getConditionCard("has_recent_location");
    hasRecentLocationCard.registerRunListener(async (args: { device: One2TrackDevice; minutes: number }) => {
      return args.device.hasRecentLocation(args.minutes);
    });

    const batteryIsBelowCard = this.homey.flow.getConditionCard("battery_is_at_or_below");
    batteryIsBelowCard.registerRunListener(async (args: { device: One2TrackDevice; threshold: number }) => {
      return args.device.hasBatteryAtOrBelow(args.threshold);
    });

    const simBalanceBelowCard = this.homey.flow.getConditionCard("sim_balance_is_at_or_below");
    simBalanceBelowCard.registerRunListener(async (args: { device: One2TrackDevice; threshold: number }) => {
      return args.device.hasSimBalanceAtOrBelow(args.threshold);
    });

    const locationIsStaleCard = this.homey.flow.getConditionCard("location_is_stale");
    locationIsStaleCard.registerRunListener(async (args: { device: One2TrackDevice; minutes: number }) => {
      return args.device.hasStaleLocation(args.minutes);
    });

    const speedAboveCard = this.homey.flow.getConditionCard("speed_is_at_or_above");
    speedAboveCard.registerRunListener(async (args: { device: One2TrackDevice; threshold: number }) => {
      return args.device.hasSpeedAtOrAbove(args.threshold);
    });

    const stepsAboveCard = this.homey.flow.getConditionCard("steps_are_at_or_above");
    stepsAboveCard.registerRunListener(async (args: { device: One2TrackDevice; threshold: number }) => {
      return args.device.hasStepsAtOrAbove(args.threshold);
    });

    const isInZoneCard = this.homey.flow.getConditionCard("is_in_zone");
    isInZoneCard.registerRunListener(
      async (args: { device: One2TrackDevice; latitude: number; longitude: number; radius_meters: number }) => {
        return args.device.isInsideZone(args.latitude, args.longitude, args.radius_meters);
      },
    );

    const isWithinHomeDistanceCard = this.homey.flow.getConditionCard("is_within_home_distance");
    isWithinHomeDistanceCard.registerRunListener(async (args: { device: One2TrackDevice; meters: number }) => {
      return args.device.isWithinHomeDistance(args.meters);
    });

    const isStationaryForCard = this.homey.flow.getConditionCard("is_stationary_for");
    isStationaryForCard.registerRunListener(async (args: { device: One2TrackDevice; minutes: number }) => {
      return args.device.isStationaryFor(args.minutes);
    });

    this.deviceTriggers = {
      locationUpdated: this.homey.flow.getDeviceTriggerCard("location_updated"),
      statusChanged: this.homey.flow.getDeviceTriggerCard("status_changed"),
      deviceWentOffline: this.homey.flow.getDeviceTriggerCard("device_went_offline"),
      deviceCameOnline: this.homey.flow.getDeviceTriggerCard("device_came_online"),
      tumbleDetected: this.homey.flow.getDeviceTriggerCard("tumble_detected"),
      tumbleCleared: this.homey.flow.getDeviceTriggerCard("tumble_cleared"),
      batteryBelowThreshold: this.homey.flow.getDeviceTriggerCard("battery_below_threshold"),
      simBalanceBelowThreshold: this.homey.flow.getDeviceTriggerCard("sim_balance_below_threshold"),
      statusBecame: this.homey.flow.getDeviceTriggerCard("status_became"),
      speedAboveThreshold: this.homey.flow.getDeviceTriggerCard("speed_above_threshold"),
      stepsAboveThreshold: this.homey.flow.getDeviceTriggerCard("steps_above_threshold"),
      locationBecameStale: this.homey.flow.getDeviceTriggerCard("location_became_stale"),
      enteredZone: this.homey.flow.getDeviceTriggerCard("entered_zone"),
      leftZone: this.homey.flow.getDeviceTriggerCard("left_zone"),
      cameWithinHomeDistance: this.homey.flow.getDeviceTriggerCard("came_within_home_distance"),
      wentBeyondHomeDistance: this.homey.flow.getDeviceTriggerCard("went_beyond_home_distance"),
      stationaryTooLong: this.homey.flow.getDeviceTriggerCard("stationary_too_long"),
      remoteShutdownRequested: this.homey.flow.getDeviceTriggerCard("remote_shutdown_requested"),
    };

    this.deviceTriggers.batteryBelowThreshold.registerRunListener(async (args: { threshold: number }, state: TriggerState) => {
      return crossedBelowThreshold(this.toOptionalNumber(state.currentBattery), this.toOptionalNumber(state.previousBattery), args.threshold);
    });

    this.deviceTriggers.simBalanceBelowThreshold.registerRunListener(async (args: { threshold: number }, state: TriggerState) => {
      return crossedBelowThreshold(
        this.toOptionalNumber(state.currentSimBalance),
        this.toOptionalNumber(state.previousSimBalance),
        args.threshold,
      );
    });

    this.deviceTriggers.statusBecame.registerRunListener(async (args: { status: TrackerStatus }, state: TriggerState) => {
      return state.currentStatus === args.status && state.previousStatus !== args.status;
    });

    this.deviceTriggers.speedAboveThreshold.registerRunListener(async (args: { threshold: number }, state: TriggerState) => {
      return crossedAboveThreshold(this.toOptionalNumber(state.currentSpeed), this.toOptionalNumber(state.previousSpeed), args.threshold);
    });

    this.deviceTriggers.stepsAboveThreshold.registerRunListener(async (args: { threshold: number }, state: TriggerState) => {
      return crossedAboveThreshold(this.toOptionalNumber(state.currentSteps), this.toOptionalNumber(state.previousSteps), args.threshold);
    });

    this.deviceTriggers.locationBecameStale.registerRunListener(async (args: { minutes: number }, state: TriggerState) => {
      return crossedAboveThreshold(
        this.toOptionalNumber(state.currentAgeMinutes),
        this.toOptionalNumber(state.previousAgeMinutes),
        args.minutes,
      );
    });

    const zoneCrossingListener = async (
      args: { latitude: number; longitude: number; radius_meters: number },
      state: TriggerState,
      direction: "in" | "out",
    ) => {
      const currentDistance = calculateDistanceMeters(
        this.toOptionalNumber(state.currentLatitude),
        this.toOptionalNumber(state.currentLongitude),
        args.latitude,
        args.longitude,
      );
      const previousDistance = calculateDistanceMeters(
        this.toOptionalNumber(state.previousLatitude),
        this.toOptionalNumber(state.previousLongitude),
        args.latitude,
        args.longitude,
      );
      return direction === "in"
        ? crossedIntoDistance(currentDistance, previousDistance, args.radius_meters)
        : crossedOutOfDistance(currentDistance, previousDistance, args.radius_meters);
    };

    this.deviceTriggers.enteredZone.registerRunListener(async (
      args: { latitude: number; longitude: number; radius_meters: number },
      state: TriggerState,
    ) => {
      return zoneCrossingListener(args, state, "in");
    });

    this.deviceTriggers.leftZone.registerRunListener(async (
      args: { latitude: number; longitude: number; radius_meters: number },
      state: TriggerState,
    ) => {
      return zoneCrossingListener(args, state, "out");
    });

    this.deviceTriggers.cameWithinHomeDistance.registerRunListener(async (args: { meters: number }, state: TriggerState) => {
      return crossedIntoDistance(
        this.toOptionalNumber(state.currentDistanceMeters),
        this.toOptionalNumber(state.previousDistanceMeters),
        args.meters,
      );
    });

    this.deviceTriggers.wentBeyondHomeDistance.registerRunListener(async (args: { kilometers: number }, state: TriggerState) => {
      return crossedOutOfDistance(
        this.toOptionalNumber(state.currentDistanceMeters),
        this.toOptionalNumber(state.previousDistanceMeters),
        args.kilometers * 1000,
      );
    });

    this.deviceTriggers.stationaryTooLong.registerRunListener(async (args: { minutes: number }, state: TriggerState) => {
      return crossedAboveThreshold(
        this.toOptionalNumber(state.currentStationaryMinutes),
        this.toOptionalNumber(state.previousStationaryMinutes),
        args.minutes,
      );
    });
  }

  async triggerLocationUpdated(device: One2TrackDevice, snapshot: TrackerSnapshot): Promise<void> {
    await this.deviceTriggers.locationUpdated.trigger(device, this.buildTokens(snapshot));
  }

  async triggerStatusChanged(device: One2TrackDevice, snapshot: TrackerSnapshot): Promise<void> {
    await this.deviceTriggers.statusChanged.trigger(device, {
      device_name: snapshot.name,
      status: this.formatStatus(snapshot.status),
    });
  }

  async triggerDeviceWentOffline(device: One2TrackDevice, snapshot: TrackerSnapshot): Promise<void> {
    await this.deviceTriggers.deviceWentOffline.trigger(device, {
      device_name: snapshot.name,
    });
  }

  async triggerDeviceCameOnline(device: One2TrackDevice, snapshot: TrackerSnapshot): Promise<void> {
    await this.deviceTriggers.deviceCameOnline.trigger(device, {
      device_name: snapshot.name,
      status: this.formatStatus(snapshot.status),
    });
  }

  async triggerTumbleDetected(device: One2TrackDevice, snapshot: TrackerSnapshot): Promise<void> {
    await this.deviceTriggers.tumbleDetected.trigger(device, {
      device_name: snapshot.name,
    });
  }

  async triggerTumbleCleared(device: One2TrackDevice, snapshot: TrackerSnapshot): Promise<void> {
    await this.deviceTriggers.tumbleCleared.trigger(device, {
      device_name: snapshot.name,
    });
  }

  async triggerBatteryBelowThreshold(
    device: One2TrackDevice,
    snapshot: TrackerSnapshot,
    previousSnapshot: TrackerSnapshot | null,
  ): Promise<void> {
    await this.deviceTriggers.batteryBelowThreshold.trigger(device, this.buildTokens(snapshot), {
      currentBattery: snapshot.batteryPercentage,
      previousBattery: previousSnapshot?.batteryPercentage ?? null,
    });
  }

  async triggerSimBalanceBelowThreshold(
    device: One2TrackDevice,
    snapshot: TrackerSnapshot,
    previousSnapshot: TrackerSnapshot | null,
  ): Promise<void> {
    await this.deviceTriggers.simBalanceBelowThreshold.trigger(device, this.buildTokens(snapshot), {
      currentSimBalance: snapshot.simBalanceEur,
      previousSimBalance: previousSnapshot?.simBalanceEur ?? null,
    });
  }

  async triggerStatusBecame(
    device: One2TrackDevice,
    snapshot: TrackerSnapshot,
    previousSnapshot: TrackerSnapshot | null,
  ): Promise<void> {
    await this.deviceTriggers.statusBecame.trigger(device, {
      device_name: snapshot.name,
      status: this.formatStatus(snapshot.status),
    }, {
      currentStatus: snapshot.status,
      previousStatus: previousSnapshot?.status ?? null,
    });
  }

  async triggerSpeedAboveThreshold(
    device: One2TrackDevice,
    snapshot: TrackerSnapshot,
    previousSnapshot: TrackerSnapshot | null,
  ): Promise<void> {
    await this.deviceTriggers.speedAboveThreshold.trigger(device, this.buildTokens(snapshot), {
      currentSpeed: snapshot.speedKmh,
      previousSpeed: previousSnapshot?.speedKmh ?? null,
    });
  }

  async triggerStepsAboveThreshold(
    device: One2TrackDevice,
    snapshot: TrackerSnapshot,
    previousSnapshot: TrackerSnapshot | null,
  ): Promise<void> {
    await this.deviceTriggers.stepsAboveThreshold.trigger(device, this.buildTokens(snapshot), {
      currentSteps: snapshot.stepCount,
      previousSteps: previousSnapshot?.stepCount ?? null,
    });
  }

  async triggerLocationBecameStale(
    device: One2TrackDevice,
    snapshot: TrackerSnapshot,
    previousAgeMinutes: number | null,
    currentAgeMinutes: number | null,
  ): Promise<void> {
    await this.deviceTriggers.locationBecameStale.trigger(device, this.buildTokens(snapshot), {
      previousAgeMinutes,
      currentAgeMinutes,
    });
  }

  async triggerZoneTransitions(
    device: One2TrackDevice,
    snapshot: TrackerSnapshot,
    previousSnapshot: TrackerSnapshot | null,
  ): Promise<void> {
    const state = {
      currentLatitude: snapshot.latitude,
      currentLongitude: snapshot.longitude,
      previousLatitude: previousSnapshot?.latitude ?? null,
      previousLongitude: previousSnapshot?.longitude ?? null,
    };

    await this.deviceTriggers.enteredZone.trigger(device, this.buildTokens(snapshot), state);
    await this.deviceTriggers.leftZone.trigger(device, this.buildTokens(snapshot), state);
  }

  async triggerHomeDistanceTransitions(
    device: One2TrackDevice,
    snapshot: TrackerSnapshot,
    previousSnapshot: TrackerSnapshot | null,
  ): Promise<void> {
    const currentDistanceMeters = device.getHomeDistanceFromSnapshot(snapshot);
    const previousDistanceMeters = device.getHomeDistanceFromSnapshot(previousSnapshot);
    const tokens = {
      ...this.buildTokens(snapshot),
      distance_meters: currentDistanceMeters ?? 0,
    };

    await this.deviceTriggers.cameWithinHomeDistance.trigger(device, tokens, {
      currentDistanceMeters,
      previousDistanceMeters,
    });

    await this.deviceTriggers.wentBeyondHomeDistance.trigger(device, tokens, {
      currentDistanceMeters,
      previousDistanceMeters,
    });
  }

  async triggerStationaryTooLong(
    device: One2TrackDevice,
    snapshot: TrackerSnapshot,
    previousStationaryMinutes: number | null,
    currentStationaryMinutes: number | null,
  ): Promise<void> {
    await this.deviceTriggers.stationaryTooLong.trigger(device, this.buildTokens(snapshot), {
      previousStationaryMinutes,
      currentStationaryMinutes,
    });
  }

  async triggerRemoteShutdownRequested(device: One2TrackDevice): Promise<void> {
    await this.deviceTriggers.remoteShutdownRequested.trigger(device, {
      device_name: device.getName(),
    });
  }

  private registerAction<TArgs extends Record<string, unknown>>(
    id: string,
    handler: (args: TArgs) => Promise<void>,
  ): void {
    const card = this.homey.flow.getActionCard(id);
    card.registerRunListener(async (args: TArgs) => {
      await handler(args);
      return true;
    });
  }

  private buildTokens(snapshot: TrackerSnapshot): FlowTokenMap {
    return {
      device_name: snapshot.name,
      status: this.formatStatus(snapshot.status),
      battery: snapshot.batteryPercentage ?? 0,
      address: snapshot.address ?? "",
      latitude: snapshot.latitude ?? 0,
      longitude: snapshot.longitude ?? 0,
      speed: snapshot.speedKmh ?? 0,
      accuracy: snapshot.accuracyMeters ?? 0,
      satellites: snapshot.satelliteCount ?? 0,
      last_location_update: snapshot.lastLocationUpdate ?? "",
      model_name: snapshot.modelName ?? "",
      heading: snapshot.headingDegrees ?? 0,
      phonebook_count: snapshot.phonebookCount ?? 0,
      whitelist_count: snapshot.whitelistCount ?? 0,
      sim_balance: snapshot.simBalanceEur ?? 0,
      steps: snapshot.stepCount ?? 0,
    };
  }

  private formatStatus(status: TrackerStatus): string {
    switch (status) {
      case "gps":
        return "GPS";
      case "wifi":
        return "Wi-Fi";
      case "offline":
      default:
        return "Offline";
    }
  }

  private getAutocompleteId(option: FlowAutocompleteOption | null | undefined, label: string): string {
    if (option && typeof option.id === "string" && option.id.trim() !== "") {
      return option.id;
    }

    throw new Error(`Missing ${label} option`);
  }

  private toOptionalNumber(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

}

export default One2TrackApp;
module.exports = One2TrackApp;
