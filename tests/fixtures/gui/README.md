# GUI Test Fixtures

Canonical synthetic test fixtures for the Splyce Windows desktop GUI test suite, conforming to [`research/docs/design/fixture-contract.md`](../../../research/docs/design/fixture-contract.md) and [`research/docs/design/client-contract.md`](../../../research/docs/design/client-contract.md).

## Manifests

| Fixture File                                                           | Case ID  | Focus Area                                              | Primary Target Task |
| :--------------------------------------------------------------------- | :------- | :------------------------------------------------------ | :------------------ |
| [`fui-w1-base-only.json`](./fui-w1-base-only.json)                     | `FUI-W1` | Base-only install and honest unconfigured state         | TD-29 / TD-34       |
| [`fui-w2-ime-composition.json`](./fui-w2-ime-composition.json)         | `FUI-W2` | IME candidate confirmation vs explicit submit           | TD-71 / TD-34       |
| [`fui-w3-accessibility.json`](./fui-w3-accessibility.json)             | `FUI-W3` | Windows Accessibility, keyboard navigation & focus trap | TD-73 / TD-34       |
| [`fui-w4-stream-backpressure.json`](./fui-w4-stream-backpressure.json) | `FUI-W4` | Stream token rendering, tool cards & rAF batching       | TD-18 / TD-34       |
| [`fui-w5-approval-race.json`](./fui-w5-approval-race.json)             | `FUI-W5` | Approval dialog race resolution & stale action blocking | TD-02 / TD-34       |
| [`fui-w6-crash-recovery.json`](./fui-w6-crash-recovery.json)           | `FUI-W6` | Crash recovery, draft retention and stale approvals     | TD-08 / TD-34       |
