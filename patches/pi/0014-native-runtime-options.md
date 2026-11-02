# Native runtime option admission

Donor: Pi `d5b3de22d0e24a3e9c38a9410d3329b099717283`, MIT; no dependencies added.

`0014-native-runtime-options.patch` applies after Splyce `8e836c5`. The native
ModelRuntime validates the original options before copying them. Only an own
data property containing an AbortSignal is accepted; inherited options,
accessors, symbols and request overrides fail before credential or network work.
Unused donor availability-refresh helpers are removed.

The final coding-agent build and the native runtime/SDK tests pass 27/27. The
registered-runtime regression failed before this fix. Valid signal-only options
remain supported. Installed-app and live-provider qualification are separate;
this record does not establish full vendor, release-gate or CI qualification.
