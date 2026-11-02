# Bedrock and Azure leased requests

The patch applies from the Splyce root to exact base
`5f36e64535238d22356d1836cc824e7451a89070`. It records the six vendor files
in the adapter merge at `7be16d0d6c6388177214cf63442a7615e587a21d`.
The selected Pi revision is `d5b3de22d0e24a3e9c38a9410d3329b099717283`;
retain its MIT license and the pinned SDK dependency closure.

Azure leases credentials per physical send and refuses mixed credential options.
Bedrock uses the leased identity without ambient credential fallback and disables
SDK retries for leased requests: the next stream must acquire a fresh lease.
Errors pass through the configured redactor. These changes do not expand grants.

## Local qualification

On the merged source, eight selected SDK test files passed 156 tests, including
actual local AWS transport, lease retry, Azure and Google credential cases. Native
provider, provider callers, host/context, dispatch and loaded session suites
passed 37, 25, 36, 71 and 25 tests respectively. Vendor typecheck and offline Pi
build passed with the installed pinned closure. The engine manifest SHA-256 was
`1e2b39ea70824ac255c8ddaf2770f88af555a44b0f9650124aeb091186c5f7f5`.

The earlier PR170 todo remains unqualified. Local loopback evidence does not
establish live provider support; GUI, full release gate and CI were not run for
this merge. Requalify the SDK seams and send behavior when dependencies change.
