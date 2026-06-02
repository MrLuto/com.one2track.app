import Homey from "homey";

import type One2TrackApp from "../../app";
import { AuthenticationError } from "../../app/domain/errors";
import { One2TrackClient } from "../../app/infra/one2trackClient";
import type { AccountCredentials, RawTrackerDevice } from "../../app/domain/types";
import type One2TrackDevice from "./device";

type LoginData = {
  username: string;
  password: string;
};

type PairContext = LoginData & {
  accountId: string;
  devices: RawTrackerDevice[];
};

function buildPairDevice(account: AccountCredentials, tracker: RawTrackerDevice) {
  return {
    name: tracker.name,
    data: {
      id: tracker.uuid,
      uuid: tracker.uuid,
      serialNumber: tracker.serial_number,
      accountId: account.accountId,
    },
    store: {
      accountId: account.accountId,
      username: account.username,
      password: account.password,
      trackerUuid: tracker.uuid,
      serialNumber: tracker.serial_number,
    },
    settings: {
      account_id: account.accountId,
      serial_number: tracker.serial_number,
      phone_number: tracker.phone_number ?? "-",
      location_type: tracker.last_location?.location_type ?? "-",
      model_name: tracker.model_name ?? "-",
      manufacturer: tracker.manufacturer ?? "One2Track",
      phonebook_count: "-",
      whitelist_count: "-",
      last_sync_at: "-",
      last_location_update: tracker.last_location?.last_location_update ?? "-",
      last_error: "-",
      allow_remote_shutdown: false,
      allow_factory_reset: false,
      allow_password_change: false,
    },
  };
}

class One2TrackDriver extends Homey.Driver {
  private pairContext: PairContext | null = null;

  private get appInstance(): One2TrackApp {
    return this.homey.app as One2TrackApp;
  }

  async onPair(session: Homey.Driver.PairSession): Promise<void> {
    session.setHandler("login", async ({ username, password }: LoginData): Promise<boolean> => {
      this.appInstance.debug("pairing", "Pair login requested", {
        username,
      });
      const client = new One2TrackClient(
        {
          accountId: "",
          username,
          password,
        },
        this.appInstance.debug.bind(this.appInstance),
        this.appInstance.debugError.bind(this.appInstance),
      );

      try {
        const accountId = await client.authenticate(true);
        const devices = await client.refreshDeviceList();

        this.pairContext = {
          username,
          password,
          accountId,
          devices: devices.map((device: RawTrackerDevice) => ({
            ...device,
            manufacturer: device.manufacturer ?? "One2Track",
          })),
        };

        this.appInstance.debug("pairing", "Pair login succeeded", {
          username,
          accountId,
          deviceCount: devices.length,
          trackerUuids: devices.map((device) => device.uuid),
        });
        return true;
      } catch (error) {
        this.appInstance.debugError("pairing", "Pair login failed", error, {
          username,
        });
        this.error("Pair login failed", error);
        if (error instanceof AuthenticationError) {
          return false;
        }

        throw error;
      }
    });

    session.setHandler("list_devices", async () => {
      if (!this.pairContext) {
        throw new AuthenticationError("No One2Track session is available for pairing");
      }

      this.appInstance.debug("pairing", "Listing pairable devices", {
        accountId: this.pairContext.accountId,
        deviceCount: this.pairContext.devices.length,
      });

      const account = {
        accountId: this.pairContext.accountId,
        username: this.pairContext.username,
        password: this.pairContext.password,
      };

      return this.pairContext.devices.map((device) => buildPairDevice(account, device));
    });
  }

  async onRepair(session: Homey.Driver.PairSession, device: One2TrackDevice): Promise<void> {
    session.setHandler("repair_credentials", async ({ username, password }: LoginData) => {
      const currentStore = device.getStore();
      this.appInstance.debug("repair", "Repair credentials requested", {
        username,
      }, {
        deviceName: device.getName(),
        trackerUuid: String(currentStore.trackerUuid ?? ""),
      });
      const client = new One2TrackClient(
        {
          accountId: String(currentStore.accountId ?? ""),
          username,
          password,
        },
        this.appInstance.debug.bind(this.appInstance),
        this.appInstance.debugError.bind(this.appInstance),
      );

      const accountId = await client.authenticate(true);
      await this.appInstance.accountManager.replaceDeviceAccount(String(device.getData().id), {
        accountId,
        username,
        password,
      });

      await device.updateSharedCredentials(accountId, username, password);
      this.appInstance.debug("repair", "Repair credentials succeeded", {
        username,
        accountId,
      }, {
        deviceName: device.getName(),
        trackerUuid: String(currentStore.trackerUuid ?? ""),
      });
      return { success: true };
    });
  }
}

export default One2TrackDriver;
module.exports = One2TrackDriver;
