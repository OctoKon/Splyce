# Selected minimatch dependency

`0017-selected-minimatch.patch` updates the coding-agent dependency to minimatch
11.0.1. Apply from the Splyce root after the existing Pi patches. The donor is
`earendil-works/pi` commit `d5b3de22d0e24a3e9c38a9410d3329b099717283`,
coding-agent 1.4.0; retain its MIT license and the dependency's BlueOak-1.0.0
license. Both workspace lockfiles record the selected version.

The existing callers use the named `minimatch` function and `Minimatch` class.
The root workspace separately pins the dependency closure used by its desktop
test tools; the Mocha compatibility record is in [../mocha/README.md](../mocha/README.md).
Native desktop and package-selection qualification must use that locked closure.
