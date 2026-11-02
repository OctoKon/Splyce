# M-171 composer IME protocol v1

**Status: UNRUN.** This defines the real-IME portion of TD-71/FUI-W2; it is not an execution receipt.

Record at execution: non-author tester, date, source revision, packaged build SHA-256 and mode, Windows/WebView2 versions, selected test workspace/session/profile, generation-ready evidence, and native evidence identifiers. Preserve the test data and recovery snapshot before interacting with an existing profile.

## Preconditions

Use the actual packaged Work composer, an unlocked desktop and an authorized, generation-ready test session with an explicitly selected provider/profile. Start each case with a nonempty, non-secret draft and an enabled Send button. Record the Microsoft IME, layout and input mode. If a precondition is unavailable, record **BLOCKED** and stop that case. A disabled Send button cannot prove the composition submission guard.

This protocol authorizes no language-pack installation, provider fallback, grant expansion or system-setting changes. Synthetic composition events, direct textarea assignment and mocked bridges do not prove physical IME behavior.

## Cases

Run every step separately with Microsoft Japanese, Microsoft Pinyin and Microsoft Korean. Use non-secret test text and actual key input through the selected IME; observe its candidate/composition UI.

1. Record the native request/run baseline, intended Unicode text and expected selection. Compose a Japanese, Chinese or Korean phrase after the draft prefix and confirm its candidate with Enter. Expected: committed text and selection match the recorded expectation; native evidence for the owned session shows **zero new submissions** during composition and candidate confirmation.
2. Paste a multiline sample containing CRLF, CR and LF, non-line-break whitespace, a combining character and a supplementary character. Record the intended LF-normalized text and selection; step 3 must match that text in the owned submitted artifact. Draft-retention and attachment/source-byte claims need separately identified oracles with source revision and result. If an oracle is unavailable, mark that claim **BLOCKED**; a visible textarea value alone does not prove persistence.
3. After composition has ended, press Ctrl+Enter once. Expected: exactly one new submission after that action contains the intended LF-normalized text for the selected session/request. Join native run/receipt/artifact identities and inspect the owned persisted text; an unrelated run or a screenshot cannot establish this result. Retain failure, cancellation or uncertainty evidence rather than treating it as success.

| Actual IME         | Expected result                        | Outcome |
| ------------------ | -------------------------------------- | ------- |
| Microsoft Japanese | Steps 1–3 satisfy their native oracles | UNRUN   |
| Microsoft Pinyin   | Steps 1–3 satisfy their native oracles | UNRUN   |
| Microsoft Korean   | Steps 1–3 satisfy their native oracles | UNRUN   |

For each step, record expected/observed values, source/build binding, evidence identifiers and **PASS / FAIL / BLOCKED**. Keep unrelated user data out of published evidence. This protocol does not qualify real-provider support, all changed controls, Narrator or full V1. M-159 bootstrap and prototype M-174 observations do not substitute for these cases.

Basis: [TD-71 and named-case ownership](../../../../research/docs/design/team-delivery-plan.md), [FUI-W2](../../../../research/docs/frontend/trust-failure-and-packaged-qualification.md#proposed-acceptance-matrix-for-existing-owners), and [composition guidance](../../../../research/docs/frontend/components-and-windows-accessibility.md#keyboard-composition-and-focus-contract).
