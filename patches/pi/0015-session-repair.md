# Session repair identity check

Donor: Pi commit `d5b3de22d0e24a3e9c38a9410d3329b099717283`,
`@earendil-works/pi-coding-agent` 1.4.0. Preserve the donor MIT license.

`0015-session-repair.patch` applies from the Splyce root after the recorded
Pi patches. `loadEntriesFromFile` retains its read descriptor during validation;
when an unterminated valid session needs a separator, it opens the path for
append without creation and verifies both descriptors' identity and size against
the number of bytes read. It also compares high-resolution modification and
change times to the read descriptor before reading. It reports a changed
session instead of repairing a replacement, a file that grew, or a file
rewritten during loading. Terminated files need no write
access. No session data is truncated or reset. The file-operation fixtures also
use an atomically created temporary directory.

Node 24.22.1 on Windows, with local source aliases for unbuilt Pi dependencies:
All 37 file-operation cases passed, including the large sparse-file case. The
replacement regression failed on the original implementation; removing the
identity and size guard caused both replacement and growth regressions to fail.
The same-length rewrite regression failed before the timestamp checks and again
when those checks were removed.
Biome passed for both changed TypeScript files. The patch reverse-apply check
passed. Real installed-app behavior and exact-head CI remain unverified.
Descriptor checks do not lock out a concurrent writer after the check, and
filesystem timestamp resolution or timestamp restoration may conceal changes;
concurrent writers still require external coordination. Reapply and rerun on donor upgrades.
