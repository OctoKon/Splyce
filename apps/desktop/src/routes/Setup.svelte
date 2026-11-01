<script lang="ts">
  import { tick, untrack } from "svelte";
  import {
    confirmInstallState,
    effectiveStateLabel,
    initialSelection,
    operationView,
    packageStateLabel,
    planView,
    selectionState,
    setupView,
    type ModuleOperation,
    type ModuleSnapshot,
  } from "../stores/modules";

  type Step =
    | "start"
    | "workbench"
    | "selecting"
    | "reviewing"
    | "operating"
    | "outcome"
    | "recovering";

  interface Props {
    snapshot: ModuleSnapshot;
    initialStep?: Step;
    onBaseOnly?: () => void;
    onSkip?: () => void;
    onRefreshCatalog?: () => void;
    onReview?: (selected: readonly string[]) => void;
    /**
     * Submits the reviewed install. `requestId` is generated here, once per
     * submission, and is the only identity that may correlate the engine's
     * operation back to this request: the engine must echo it on every update
     * for that operation.
     */
    onConfirmInstall?: (request: {
      requestId: string;
      planId: string;
      enableRequested: boolean;
      executionGranted: boolean;
    }) => void;
    onCancelOperation?: (operationId: string) => void;
    /** A retry is a new request, so it carries a fresh `requestId` too. */
    onRetryOperation?: (
      operationId: string,
      request: { requestId: string },
    ) => void;
    onOpenModules?: () => void;
    onConfigureProvider?: () => void;
    onEnterWorkbench?: () => void;
  }

  let {
    snapshot,
    initialStep = "start",
    onBaseOnly = () => {},
    onSkip = () => {},
    onRefreshCatalog = () => {},
    onReview = () => {},
    onConfirmInstall = () => {},
    onCancelOperation = () => {},
    onRetryOperation = () => {},
    onOpenModules = () => {},
    onConfigureProvider = () => {},
    onEnterWorkbench = () => {},
  }: Props = $props();

  let step = $state<Step>(untrack(() => initialStep));
  // Ambient configuration and earlier snapshots never seed a selection.
  let selected = $state<readonly string[]>(initialSelection());
  let enableAfterInstall = $state(false);
  let executionGranted = $state(false);
  let lastPlanId: string | null = null;
  // The request awaiting an engine operation. It records the request identity
  // this renderer minted for the submission and the reviewed plan, so only an
  // operation the engine echoes that identity on can be mistaken for this
  // request's acceptance. An unrelated or pre-existing operation never matches:
  // request ids are unique per submission.
  let pendingOperation = $state<{
    readonly requestId: string;
    readonly planId: string | null;
  } | null>(null);
  let requestSeq = 0;

  /**
   * Mints a request identity that is unique per submission. It is sent with the
   * request and must be echoed by the engine on that request's operations.
   */
  function newRequestId(): string {
    requestSeq += 1;
    const random = globalThis.crypto?.randomUUID?.();
    return random
      ? `setup-request-${random}`
      : `setup-request-${Date.now().toString(36)}-${requestSeq}`;
  }
  // The one engine operation this screen may show, and its last seen value so a
  // replacement by an unrelated operation cannot blank or hijack the outcome.
  let admittedOperationId = $state<string | null>(
    untrack(() =>
      initialStep === "operating" ||
      initialStep === "outcome" ||
      initialStep === "recovering"
        ? (snapshot.operation?.operationId ?? null)
        : null,
    ),
  );
  let lastAdmittedOperation = $state<ModuleOperation | null>(
    untrack(() =>
      initialStep === "operating" ||
      initialStep === "outcome" ||
      initialStep === "recovering"
        ? snapshot.operation
        : null,
    ),
  );

  let baseButton = $state<HTMLButtonElement>();
  let reviewButton = $state<HTMLButtonElement>();
  let reviewHeading = $state<HTMLHeadingElement>();
  let pageHeading = $state<HTMLHeadingElement>();
  let focusedStart = false;

  const view = $derived(setupView(snapshot));
  const selection = $derived(selectionState(snapshot, selected));
  const confirm = $derived(
    confirmInstallState({
      engine: snapshot.engine,
      engineReason: snapshot.engineReason,
      plan: snapshot.plan,
      selected,
      executionGranted,
    }),
  );
  const review = $derived(
    snapshot.plan ? planView(snapshot.plan, selected) : null,
  );
  const shownOperation = $derived(
    snapshot.operation &&
      admittedOperationId !== null &&
      snapshot.operation.operationId === admittedOperationId
      ? snapshot.operation
      : lastAdmittedOperation,
  );
  const operation = $derived(operationView(snapshot, shownOperation));
  const target = $derived(
    shownOperation?.packageId
      ? snapshot.installed.find(
          (item) => item.packageId === shownOperation.packageId,
        )
      : undefined,
  );
  const facts = $derived({
    installed: target
      ? `${packageStateLabel(target.state)} (${target.installationRevision})`
      : "No installed record reported by the engine.",
    enabled: target
      ? `${target.requestedEnabled ? "Enabled requested" : "Off requested"}; effective ${effectiveStateLabel(target.effective)}`
      : "No requested or effective state reported by the engine.",
    ready: target
      ? target.effective === "ready"
        ? "Ready"
        : `${effectiveStateLabel(target.effective)}${target.readinessReason ? ` — ${target.readinessReason}` : ""}`
      : "No readiness reported by the engine.",
  });

  $effect(() => {
    const planId = snapshot.plan?.planId ?? null;
    if (planId === lastPlanId) return;
    lastPlanId = planId;
    enableAfterInstall = false;
    executionGranted = false;
    // A replaced plan invalidates the pending request it was reviewed for.
    pendingOperation = null;
  });

  // Authoritative, correlated progression only: the engine's echoed request
  // identity and the operation stage drive reviewing -> operating ->
  // outcome/recovering. Only an operation that carries the requestId this
  // renderer minted for the submission can accept it; an unrelated or
  // pre-existing operation (even one of the same kind and target) is ignored and
  // the review keeps waiting. Submitting or clicking never advances this state.
  $effect(() => {
    const current = snapshot.operation;
    const planId = snapshot.plan?.planId ?? null;

    // Acceptance of a pending request/retry: the engine echoed this request's
    // identity, and for an install the reviewed plan must still be current.
    const pending = pendingOperation;
    if (pending && current && current.requestId === pending.requestId) {
      if (step !== "reviewing" || planId === pending.planId) {
        admittedOperationId = current.operationId;
        lastAdmittedOperation = current;
        pendingOperation = null;
        step = "operating";
        return;
      }
    }

    if (step !== "operating" && step !== "outcome" && step !== "recovering") {
      return;
    }

    // Only the admitted operation speaks for this screen; a different
    // operation is unrelated and cannot advance or replace it.
    const admitted =
      current && current.operationId === admittedOperationId ? current : null;
    if (admitted) lastAdmittedOperation = admitted;

    // A lost correlation after admission is uncertainty, never success.
    if (!admitted) {
      if (step === "operating") step = "recovering";
      return;
    }

    // Engine exit or restart during an operation leaves pending recovery.
    if (step === "operating" && snapshot.engine !== "ready") {
      step = "recovering";
      return;
    }

    if (admitted.stage !== "outcome") {
      // A newer update for the same operation replaces a previous terminal view.
      if (step === "outcome") step = "operating";
      return;
    }

    step =
      admitted.outcome === "uncertain" || admitted.cleanupPending
        ? "recovering"
        : "outcome";
  });

  $effect(() => {
    if (step === "start" && !focusedStart) {
      focusedStart = true;
      void tick().then(() => baseButton?.focus());
    }
  });

  $effect(() => {
    if (step === "reviewing") void tick().then(() => reviewHeading?.focus());
  });

  function focusPage() {
    void tick().then(() => pageHeading?.focus());
  }

  function baseOnly() {
    onBaseOnly();
    onEnterWorkbench();
    step = "workbench";
    focusPage();
  }

  function skip() {
    onSkip();
    onEnterWorkbench();
    step = "workbench";
    focusPage();
  }

  function chooseModules() {
    step = "selecting";
    focusPage();
  }

  function backToStart() {
    step = "start";
    focusPage();
  }

  function toggle(packageId: string, checked: boolean) {
    selected = checked
      ? [...selected.filter((id) => id !== packageId), packageId]
      : selected.filter((id) => id !== packageId);
  }

  function reviewSelection() {
    if (!selection.enabled) return;
    onReview([...selected]);
    step = "reviewing";
  }

  function backToSelection() {
    pendingOperation = null;
    step = "selecting";
    void tick().then(() => reviewButton?.focus());
  }

  function cancelReview() {
    // Cancel closes the unsent review without submission and restores its opener.
    pendingOperation = null;
    step = "selecting";
    void tick().then(() => reviewButton?.focus());
  }

  function install() {
    const plan = snapshot.plan;
    if (!confirm.enabled || !plan || pendingOperation) return;
    const requestId = newRequestId();
    onConfirmInstall({
      requestId,
      planId: plan.planId,
      enableRequested: enableAfterInstall,
      executionGranted,
    });
    // Record the request identity and the reviewed plan, then wait. The screen
    // advances only when the engine reports an operation echoing this requestId.
    pendingOperation = { requestId, planId: plan.planId };
  }

  function cancelOperation() {
    const current = shownOperation;
    if (!current || !operation?.canCancel.enabled) return;
    onCancelOperation(current.operationId);
  }

  function retryOperation() {
    const current = shownOperation;
    if (!current || !operation?.canRetry.enabled || pendingOperation) return;
    const requestId = newRequestId();
    onRetryOperation(current.operationId, { requestId });
    // A retry is a new request too: only an operation echoing this requestId
    // accepts it.
    pendingOperation = { requestId, planId: snapshot.plan?.planId ?? null };
  }

  function done() {
    onEnterWorkbench();
    step = "workbench";
    focusPage();
  }

  function onkeydown(event: KeyboardEvent) {
    // Escape dismisses only unsent review. It never cancels admitted work.
    if (step !== "reviewing" || event.key !== "Escape") return;
    event.preventDefault();
    cancelReview();
  }
</script>

<svelte:window {onkeydown} />

<main
  class="setup"
  data-testid="setup"
  data-step={step}
  aria-labelledby="setup-title"
>
  <header class="setup-header">
    <p class="eyebrow">Splyce setup</p>
    <h1 id="setup-title" bind:this={pageHeading} tabindex="-1">Set up Splyce</h1>
    <p
      class="generation"
      data-testid="generation"
      data-state={snapshot.generation.state}
    >
      <strong>{view.generationLabel}</strong>
      {#if view.generationReason}
        <span>— {view.generationReason}</span>
      {/if}
    </p>
    {#if snapshot.engine !== "ready"}
      <p class="banner" role="alert" data-testid="engine-unavailable">
        {snapshot.engine === "stale"
          ? "Engine state is stale. This view is read-only and effect controls are disabled."
          : "Engine unavailable. This view is read-only and effect controls are disabled."}
        {snapshot.engineReason ? ` ${snapshot.engineReason}` : ""}
      </p>
    {/if}
    {#if view.ambientNotice}
      <p class="banner" role="note" data-testid="ambient-notice">
        {view.ambientNotice}
      </p>
    {/if}
  </header>

  {#if step === "start"}
    <section aria-labelledby="start-title" class="panel">
      <h2 id="start-title">Start with the base</h2>
      <p>{view.baseBody}</p>
      <div class="primary">
        <button
          bind:this={baseButton}
          type="button"
          class="primary-action"
          onclick={baseOnly}
          data-testid="base-only"
        >
          Continue with base only
        </button>
        <p>
          Primary default. No network, catalog, credential or generation model
          is needed to continue.
        </p>
      </div>
      <div class="actions">
        <button type="button" onclick={chooseModules} data-testid="choose-modules">
          Choose optional modules
        </button>
        <button type="button" onclick={skip} data-testid="skip">
          Skip setup
        </button>
      </div>
      <div class="columns">
        <section aria-labelledby="base-includes">
          <h3 id="base-includes">Included in the base</h3>
          <ul>
            {#each view.baseIncludes as item (item)}<li>{item}</li>{/each}
          </ul>
        </section>
        <section aria-labelledby="base-excludes">
          <h3 id="base-excludes">Not installed by default</h3>
          <ul>
            {#each view.baseExcludes as item (item)}<li>{item}</li>{/each}
          </ul>
        </section>
      </div>
    </section>
  {:else if step === "workbench"}
    <section aria-labelledby="workbench-title" class="panel">
      <h2 id="workbench-title">Base-only workbench</h2>
      <p>
        Setup is complete. The base is usable without optional modules. Task
        execution still needs an explicitly selected compatible generation
        model.
      </p>
      <p data-testid="workbench-generation">
        {view.generationLabel}
        {#if view.generationReason}— {view.generationReason}{/if}
      </p>
      <div class="actions">
        <button type="button" onclick={onConfigureProvider} data-testid="configure-provider">
          Configure a provider or model
        </button>
        <button type="button" onclick={onOpenModules} data-testid="open-modules">
          Open modules
        </button>
        <button type="button" onclick={onEnterWorkbench} data-testid="enter-workbench">
          Open the workbench
        </button>
      </div>
    </section>
  {:else if step === "selecting"}
    <section aria-labelledby="select-title" class="panel">
      <h2 id="select-title">Choose optional modules</h2>
      <p>
        Selections start empty. Nothing is fetched, imported or installed until
        you review the exact closure and confirm a current plan.
      </p>
      <p data-testid="catalog-label">
        <strong>{view.catalogLabel}</strong>
        <span class="detail">{view.catalogDetail}</span>
      </p>

      {#if view.catalogUnavailableReason}
        <div class="banner" role="alert" data-testid="catalog-unavailable">
          <p>Catalog unavailable: {view.catalogUnavailableReason}</p>
          <p>This is not an empty successful catalog.</p>
          <div class="actions">
            <button
              type="button"
              disabled={snapshot.engine !== "ready"}
              title={snapshot.engine !== "ready"
                ? (snapshot.engineReason ?? "Engine unavailable.")
                : undefined}
              onclick={onRefreshCatalog}
              data-testid="refresh-catalog"
            >
              Refresh catalog
            </button>
            <button type="button" onclick={baseOnly}>Continue with base only</button>
            <button type="button" onclick={skip}>Skip setup</button>
          </div>
        </div>
      {:else if view.entries.length === 0}
        <p role="status">The cached catalog lists no optional modules.</p>
      {:else}
        <ul class="module-options">
          {#each view.entries as entry (entry.packageId)}
            <li
              data-testid="module-option"
              data-package-id={entry.packageId}
              data-selected={selected.includes(entry.packageId)}
            >
              <label class="check">
                <input
                  type="checkbox"
                  checked={selected.includes(entry.packageId)}
                  disabled={!entry.selectable}
                  onchange={(event) =>
                    toggle(
                      entry.packageId,
                      (event.currentTarget as HTMLInputElement).checked,
                    )}
                />
                <span>
                  <strong>{entry.title}</strong>
                  <span class="detail">{entry.summary}</span>
                </span>
              </label>
              {#if entry.selectBlockedReason}
                <p role="alert" class="blocker">{entry.selectBlockedReason}</p>
              {/if}
              <dl>
                <dt>Source</dt><dd>{entry.sourceLabel}</dd>
                <dt>Digest</dt><dd><code>{entry.digestLabel}</code></dd>
                <dt>License</dt><dd>{entry.licenseLabel}</dd>
                <dt>Compatibility</dt><dd>{entry.compatibilityLabel}</dd>
                <dt>Download</dt><dd>{entry.downloadLabel}</dd>
                <dt>Installed size</dt><dd>{entry.installedLabel}</dd>
                <dt>Dependencies</dt><dd>{entry.dependencyLabel}</dd>
              </dl>
              {#if entry.setupExecutionLabel}
                <p data-testid="setup-execution-warning">
                  {entry.setupExecutionLabel}
                </p>
              {/if}
              {#if entry.modelLabel}<p>{entry.modelLabel}</p>{/if}
            </li>
          {/each}
        </ul>
      {/if}

      <p data-testid="selection-count">Selected: {selected.length} module(s).</p>
      <div class="actions">
        <button
          bind:this={reviewButton}
          type="button"
          disabled={!selection.enabled}
          title={selection.reason ?? undefined}
          aria-describedby={selection.reason ? "selection-reason" : undefined}
          onclick={reviewSelection}
          data-testid="review-install"
        >
          Review install
        </button>
        <button type="button" onclick={backToStart}>Back</button>
      </div>
      {#if selection.reason}
        <p id="selection-reason" role="status" class="reason">{selection.reason}</p>
      {/if}
    </section>
  {:else if step === "reviewing"}
    <section aria-labelledby="review-title" class="panel">
      <h2 id="review-title" tabindex="-1" bind:this={reviewHeading}>
        Review install
      </h2>

      {#if !review}
        <p role="status" data-testid="setup-plan-missing">
          Waiting for an install plan from the engine. Nothing has been
          installed.
        </p>
        <div class="actions">
          <button type="button" onclick={backToSelection}>
            Back to selection
          </button>
        </div>
      {:else}
        <p
          data-testid="plan-state"
          data-current={review.current}
          class:warning={!review.current}
        >
          {review.stateLabel}
        </p>
        {#if review.reason}
          <p role="alert" class="banner">{review.reason}</p>
        {/if}

        <h3>Selected roots</h3>
        <ul>
          {#each review.roots as entry (entry.packageId)}
            <li data-testid="plan-root" data-package-id={entry.packageId}>
              <strong>{entry.title}</strong> ({entry.roleLabel})
              <dl>
                <dt>Source</dt><dd>{entry.sourceLabel}</dd>
                <dt>Digest</dt><dd><code>{entry.digestLabel}</code></dd>
                <dt>License</dt><dd>{entry.licenseLabel}</dd>
                <dt>Download</dt><dd>{entry.downloadLabel}</dd>
                <dt>Installed size</dt><dd>{entry.installedLabel}</dd>
              </dl>
              {#if entry.setupExecution}
                <p>Includes an executable setup step; its grant is separate.</p>
              {/if}
              {#if entry.modelLabel}<p>{entry.modelLabel}</p>{/if}
              {#if entry.sharedLabel}<p>{entry.sharedLabel}</p>{/if}
            </li>
          {/each}
        </ul>

        <h3>Required dependencies</h3>
        {#if review.dependencies.length === 0}
          <p>None. Only the selected roots are in the accepted closure.</p>
        {:else}
          <ul>
            {#each review.dependencies as entry (entry.packageId)}
              <li data-testid="plan-dependency" data-package-id={entry.packageId}>
                <strong>{entry.title}</strong> ({entry.roleLabel})
                <dl>
                  <dt>Source</dt><dd>{entry.sourceLabel}</dd>
                  <dt>Digest</dt><dd><code>{entry.digestLabel}</code></dd>
                  <dt>Download</dt><dd>{entry.downloadLabel}</dd>
                  <dt>Installed size</dt><dd>{entry.installedLabel}</dd>
                </dl>
                {#if entry.sharedLabel}<p>{entry.sharedLabel}</p>{/if}
              </li>
            {/each}
          </ul>
        {/if}

        <p data-testid="plan-totals">
          Download: {review.downloadLabel}. Installed: {review.installedLabel}.
          An unknown size is not zero.
        </p>
        {#if review.modelLabels.length > 0}
          <p data-testid="plan-models">
            Separate models are not part of this plan: {review.modelLabels.join(
              ", ",
            )}. Select or provision them separately; no weight download starts
            here.
          </p>
        {/if}

        <label class="check">
          <input
            type="checkbox"
            bind:checked={enableAfterInstall}
            data-testid="enable-after-install"
          />
          Also request enable after install (separate outcome; starts off)
        </label>

        {#if review.requiresSetupExecution}
          <div class="banner" data-testid="execution-step">
            <p>
              This plan includes an executable setup step. Installation alone
              does not grant permission to run it.
            </p>
            <label class="check">
              <input
                type="checkbox"
                bind:checked={executionGranted}
                data-testid="execution-grant"
              />
              Grant the reviewed setup execution step
            </label>
          </div>
        {/if}

        <div class="actions">
          <button
            type="button"
            disabled={!confirm.enabled || pendingOperation !== null}
            title={confirm.reason ?? undefined}
            aria-describedby={confirm.reason ? "confirm-reason" : undefined}
            onclick={install}
            data-testid="confirm-install"
          >
            Install selected modules
          </button>
          <button type="button" onclick={backToSelection}>
            Back to selection
          </button>
          <button type="button" onclick={cancelReview}>Cancel</button>
        </div>
        {#if confirm.reason}
          <p id="confirm-reason" role="status" class="reason" data-testid="confirm-reason">
            {confirm.reason}
          </p>
        {/if}
        {#if pendingOperation}
          <p role="status" class="reason" data-testid="awaiting-operation">
            Request submitted. Waiting for the engine to echo this request's
            identity and report its operation; an operation that was already in
            the snapshot before submission, or one that does not carry this
            request's identity, is not evidence for this request. Nothing is
            shown as installed until its durable outcome. Request
            <code data-testid="awaiting-request-id"
              >{pendingOperation.requestId}</code
            >.
          </p>
        {/if}
      {/if}
    </section>
  {:else if step === "operating" || step === "outcome" || step === "recovering"}
    <section
      aria-labelledby="operation-title"
      class="panel"
      data-testid={step === "operating"
        ? "setup-operation"
        : step === "outcome"
          ? "setup-outcome"
          : "setup-recovering"}
    >
      <h2 id="operation-title">
        {step === "operating"
          ? "Operation in progress"
          : step === "outcome"
            ? "Operation outcome"
            : "Recover setup"}
      </h2>

      {#if step === "recovering"}
        <p>
          No effect is replayed automatically. This shows the last durable
          record reported by the engine.
        </p>
      {/if}

      {#if operation}
        <p>
          {operation.kindLabel} · {operation.stageLabel} ·
          <code>{operation.operationId}</code>
        </p>
        <p role="status" data-testid="operation-message">{operation.message}</p>

        {#if operation.progressLabel}
          <progress
            aria-label="Operation progress"
            value={operation.progressValue ?? undefined}
            max="1"
          ></progress>
          <p data-testid="operation-progress">{operation.progressLabel}</p>
        {/if}

        {#if operation.outcomeLabel}
          <p
            role={operation.outcomeTone === "negative" ? "alert" : "status"}
            data-testid="operation-outcome"
            data-tone={operation.outcomeTone}
          >
            Outcome: {operation.outcomeLabel}
          </p>
        {/if}

        <dl data-testid="outcome-facts">
          <dt>Installed</dt>
          <dd data-testid="fact-installed">{facts.installed}</dd>
          <dt>Enabled</dt>
          <dd data-testid="fact-enabled">{facts.enabled}</dd>
          <dt>Ready</dt>
          <dd data-testid="fact-ready">{facts.ready}</dd>
        </dl>

        {#if operation.cleanupLabel}
          <p role="alert" class="banner">{operation.cleanupLabel}</p>
        {/if}

        <div class="actions">
          {#if step === "operating"}
            <button
              type="button"
              disabled={!operation.canCancel.enabled}
              title={operation.canCancel.reason ?? undefined}
              onclick={cancelOperation}
              data-testid="cancel-operation"
            >
              Cancel this operation
            </button>
            <button type="button" onclick={done}>Back to workbench</button>
          {:else}
            <button
              type="button"
              disabled={!operation.canRetry.enabled || pendingOperation !== null}
              title={operation.canRetry.reason ?? undefined}
              onclick={retryOperation}
              data-testid="retry-operation"
            >
              Retry reconciled operation
            </button>
            <button type="button" onclick={done} data-testid="operation-done">
              Done
            </button>
          {/if}
        </div>
        {#if step === "operating" && operation.canCancel.reason}
          <p class="reason">{operation.canCancel.reason}</p>
        {/if}
        {#if step !== "operating" && operation.canRetry.reason}
          <p class="reason" data-testid="retry-reason">
            {operation.canRetry.reason}
          </p>
        {/if}
      {:else}
        <p role="status" data-testid="operation-missing">
          No operation identity has been reported by the engine. Nothing is
          shown as installed, enabled or ready.
        </p>
        <div class="actions">
          <button type="button" onclick={done}>Back to workbench</button>
        </div>
      {/if}
    </section>
  {/if}
</main>

<style>
  .setup {
    max-width: 880px;
    margin: 0 auto;
    padding: 24px;
    box-sizing: border-box;
    color: #111827;
  }
  .setup-header h1 {
    margin: 4px 0 8px;
    font-size: 1.5rem;
  }
  .setup-header h1:focus-visible,
  h2:focus-visible {
    outline: 2px solid currentColor;
    outline-offset: 3px;
  }
  .eyebrow {
    margin: 0;
    font-size: 0.75rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #4b5563;
  }
  .generation {
    margin: 0 0 12px;
    font-size: 0.875rem;
  }
  .generation[data-state="unconfigured"] strong {
    color: #92400e;
  }
  .panel {
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    padding: 20px;
    margin-top: 16px;
    background: #ffffff;
  }
  .panel h2 {
    margin-top: 0;
  }
  .detail {
    display: block;
    color: #4b5563;
    font-size: 0.875rem;
  }
  .banner {
    padding: 8px 12px;
    border-radius: 6px;
    background: #fffbeb;
    border: 1px solid #fcd34d;
    color: #78350f;
    font-size: 0.875rem;
  }
  .warning {
    color: #92400e;
    font-weight: 600;
  }
  .primary {
    margin: 16px 0;
  }
  .primary-action {
    font-weight: 700;
    padding: 10px 16px;
  }
  .primary p {
    margin: 6px 0 0;
    color: #4b5563;
    font-size: 0.875rem;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 16px;
  }
  button {
    font: inherit;
    padding: 6px 12px;
    border: 1px solid #9ca3af;
    border-radius: 6px;
    background: #ffffff;
    color: inherit;
    cursor: pointer;
  }
  button:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }
  button:focus-visible,
  input:focus-visible {
    outline: 2px solid currentColor;
    outline-offset: 2px;
  }
  .columns {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 16px;
    margin-top: 16px;
  }
  .columns h3 {
    margin-bottom: 4px;
    font-size: 0.9375rem;
  }
  .module-options {
    list-style: none;
    padding: 0;
    margin: 16px 0;
    display: grid;
    gap: 12px;
  }
  .module-options > li {
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    padding: 12px;
  }
  .check {
    display: flex;
    gap: 8px;
    align-items: flex-start;
  }
  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 2px 12px;
    margin: 8px 0 0;
    font-size: 0.8125rem;
  }
  dt {
    color: #4b5563;
    font-weight: 600;
  }
  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  code {
    font-size: 0.8125rem;
  }
  .blocker,
  .reason {
    color: #991b1b;
    font-size: 0.875rem;
  }
  progress {
    width: 100%;
    max-width: 420px;
  }
</style>
