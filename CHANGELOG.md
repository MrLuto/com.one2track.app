# Changelog

## 1.2.0
- Added a Send Debug To Developer option for detailed debugging.

## 1.0.2
- Raised the minimum Homey version to 12.0.1 for dynamic enum capability options.
- Replaced the app image with a compliant Homey App Store image without phone app mockups.
- Added the missing 1000x1000 driver image and switched the app icon to a transparent background.
- Shortened the store README text and improved the manifest description and author metadata.

## 1.0.1
- Fixed Homey runtime exports for the app, driver and device entrypoints so the app starts correctly on Homey Pro instead of crashing with exit code 1 during boot.

## 1.0.0
- Initial Homey SDK v3 implementation for One2Track GPS trackers.
- Added dynamic command discovery for model-specific controls and advanced Flow actions.
- Added device controls for find device, GPS interval, profile mode and step counter where supported.
- Added cached tracker settings for phonebook, whitelist, alarms and quiet times.
- Added advanced diagnostics, safety guards for destructive actions and App Store metadata updates.
- Scoped the release to Homey Pro only and removed Homey Cloud positioning from the manifest and docs.
