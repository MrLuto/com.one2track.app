# One2Track for Homey Pro

Homey Pro app for One2Track GPS watches and trackers.

The app connects to the One2Track web portal, discovers the trackers on your account, and exposes them in Homey with live status, location updates, safety alerts, and remote actions. Device-specific controls such as GPS interval, profile mode, phonebook, whitelist, and advanced commands are only shown when the paired watch model supports them.

## Features

- Pair multiple One2Track devices from a single account
- Shared account session and polling across paired trackers
- Battery, status, speed, altitude, signal, satellites, steps, heading, SIM balance, and address
- Flow actions for messaging, force update, find device, GPS interval, profile mode, phonebook, whitelist, intercom, and more
- Flow triggers for status changes, offline/online transitions, tumble detection, battery and SIM thresholds, stale location, speed/steps thresholds, custom zones, Homey distance checks, and stationary detection
- Dangerous commands such as remote shutdown, factory reset, and password changes are disabled by default and must be explicitly enabled per device

## Pairing

1. Install the app on Homey Pro.
2. Add a new One2Track device.
3. Sign in with your One2Track account credentials.
4. Select one or more trackers from the discovered device list.

The app keeps one shared authenticated session per account so multiple paired devices do not each create their own poller.

## Notes

- `WIFI` is treated as a tracker status, not as Homey presence.
- The app depends on One2Track's web portal behavior. If the upstream portal changes its login flow or command forms, a repair or app update may be required.
- Credentials are stored on Homey because the app must maintain a working session for polling and remote commands.

## Development

```bash
npm install
npm run build
npm test
homey app validate --level publish
homey app run
```

## Credits

This app was built with functional inspiration from the One2Track Home Assistant community integrations, especially:

- `vandernorth/one2track`
- `renedis/one2track`
- `jurrienk/ha-one2track`
