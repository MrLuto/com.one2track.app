# Review Notes

This app integrates One2Track GPS watches into Homey by automating the same web portal flows that are available to end users in the official One2Track service.

Implementation notes:
- The app uses the user's own One2Track credentials and keeps a shared session per Homey account pairing.
- Device capabilities are discovered dynamically from the upstream portal instead of hardcoding every model.
- Risky commands such as remote shutdown, factory reset and password changes are guarded behind per-device opt-in settings.
- WIFI is treated as an upstream tracker status and is not mapped to Homey presence.

Credits and prior art:
- https://github.com/vandernorth/one2track
- https://github.com/renedis/one2track
- https://github.com/jurrienk/ha-one2track

These repositories were used as behavioural references for portal endpoints, command codes and edge cases. This Homey app is a separate SDK v3 implementation with Homey-specific pairing, device, flow and capability handling.
