# Native bootstrap UI Automation subset

Tracking: [bounded TD-34 subset](https://github.com/OctoKon/Splyce/issues/49).

After building the release application and its selected Node 24.22.1 resources,
run from the repository root in an interactive Windows desktop session:

```powershell
powershell.exe -NoProfile -NonInteractive -File apps/desktop/tests/gui/uia/bootstrap.ps1
```

The harness uses Windows PowerShell's .NET UI Automation assemblies, launches only
the known release executable, and scopes accessibility queries to its native
window. It checks accessible unavailable text, terminates only the revalidated
owned Node child, checks accessible engine-stopped text, and closes its window.
It refuses an existing instance of the same executable. Failure exits nonzero.

Reports, native accessibility trees, executable digests and application logs stay
under ignored `apps/desktop/src-tauri/target/bootstrap-smoke/uia-*`. Screenshots
from a separate driver run do not substitute for these accessibility assertions.

This subset does not qualify TD-34 in full, TD-54, installed NSIS behavior,
keyboard/focus, IME, Narrator, contrast, DPI or the non-author manual `M` protocol.
The bootstrap has no interactive web controls; its zero unnamed controls result
cannot qualify labels for future controls.
