<script lang="ts">
  import { tick } from "svelte";
  import {
    addModuleState,
    catalogEntryView,
    enableBlockers,
    moduleActionState,
    modulesView,
    operationView,
    selectionState,
    type ModuleRowView,
    type ModuleSnapshot,
  } from "../stores/modules";
  import OptionalStateHelp from "../components/OptionalStateHelp.svelte";
  import { moduleOptionalState } from "./module-optional-state";

  type Dialog =
    | { readonly kind: "add" }
    | {
        readonly kind: "enable" | "disable" | "uninstall" | "delete-data";
        readonly packageId: string;
      }
    | null;

  interface Props {
    snapshot: ModuleSnapshot;
    onRefreshCatalog?: () => void;
    onAdd?: (selectedIds: readonly string[]) => void;
    onEnable?: (packageId: string) => void;
    onDisable?: (packageId: string) => void;
    onUninstall?: (packageId: string) => void;
    onDeleteData?: (packageId: string) => void;
    onCancelOperation?: (operationId: string) => void;
    onRetryOperation?: (operationId: string) => void;
    onConfigureProvider?: () => void;
  }

  let {
    snapshot,
    onRefreshCatalog = () => {},
    onAdd = () => {},
    onEnable = () => {},
    onDisable = () => {},
    onUninstall = () => {},
    onDeleteData = () => {},
    onCancelOperation = () => {},
    onRetryOperation = () => {},
    onConfigureProvider = () => {},
  }: Props = $props();

  let dialog = $state<Dialog>(null);
  let addSelected = $state<readonly string[]>([]);
  let opener: HTMLElement | null = null;
  let dialogEl = $state<HTMLDivElement>();

  const view = $derived(modulesView(snapshot));
  const operation = $derived(operationView(snapshot, snapshot.operation));
  const addState = $derived(addModuleState(snapshot));
  const addSelection = $derived(selectionState(snapshot, addSelected));
  // TD-68: only the optional states the snapshot proves; never inferred.
  const optionalState = (row: ModuleRowView) =>
    moduleOptionalState(row, snapshot);
  // Narrowing helpers: keep the id as a plain value before the callback.
  const dialogPackageId = $derived(
    dialog && dialog.kind !== "add" ? dialog.packageId : null,
  );
  const installedTarget = $derived(
    dialogPackageId === null
      ? undefined
      : snapshot.installed.find((item) => item.packageId === dialogPackageId),
  );
  const targetRow = $derived(
    dialogPackageId === null
      ? undefined
      : view.rows.find((row) => row.packageId === dialogPackageId),
  );
  const targetEntry = $derived(
    installedTarget
      ? snapshot.entries.find(
          (entry) => entry.packageId === installedTarget.packageId,
        )
      : undefined,
  );
  const dialogAction = $derived(
    dialog && dialog.kind !== "add" && installedTarget
      ? moduleActionState(snapshot, installedTarget, dialog.kind)
      : null,
  );
  const dialogBlockers = $derived(
    dialog?.kind === "enable" && installedTarget
      ? enableBlockers(snapshot, installedTarget)
      : [],
  );

  $effect(() => {
    if (!dialog) return;
    void tick().then(() => {
      const first = dialogEl?.querySelector<HTMLElement>("[data-autofocus]");
      (first ?? dialogEl)?.focus();
    });
  });

  function openDialog(next: Dialog) {
    if (!dialog) opener = document.activeElement as HTMLElement | null;
    if (next?.kind === "add") addSelected = [];
    dialog = next;
  }

  function closeDialog() {
    dialog = null;
    const target = opener;
    opener = null;
    void tick().then(() => target?.focus());
  }

  function toggleAdd(packageId: string, checked: boolean) {
    addSelected = checked
      ? [...addSelected.filter((id) => id !== packageId), packageId]
      : addSelected.filter((id) => id !== packageId);
  }

  function reviewAdd() {
    if (!addSelection.enabled) return;
    onAdd([...addSelected]);
    closeDialog();
  }

  function confirmDialog() {
    if (!dialog || dialog.kind === "add" || !dialogAction?.enabled) return;
    const packageId = dialog.packageId;
    if (dialog.kind === "enable") onEnable(packageId);
    else if (dialog.kind === "disable") onDisable(packageId);
    else if (dialog.kind === "uninstall") onUninstall(packageId);
    else onDeleteData(packageId);
    closeDialog();
  }

  function openDeleteData(packageId: string) {
    // A separate scoped choice; uninstall never deletes retained data.
    openDialog({ kind: "delete-data", packageId });
  }

  function cancelOperation() {
    const current = snapshot.operation;
    if (!current || !operation?.canCancel.enabled) return;
    onCancelOperation(current.operationId);
  }

  function retryOperation() {
    const current = snapshot.operation;
    if (!current || !operation?.canRetry.enabled) return;
    onRetryOperation(current.operationId);
  }

  function onDialogKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeDialog();
      return;
    }
    if (event.key !== "Tab" || !dialogEl) return;
    const focusable = [
      ...dialogEl.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [href], select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ];
    if (focusable.length === 0) {
      event.preventDefault();
      dialogEl.focus();
      return;
    }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const active = document.activeElement;
    if (!dialogEl.contains(active)) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const dialogTitle = $derived(
    !dialog
      ? ""
      : dialog.kind === "add"
        ? "Add optional modules"
        : dialog.kind === "enable"
          ? `Enable ${targetRow?.title ?? dialog.packageId}`
          : dialog.kind === "disable"
            ? `Disable ${targetRow?.title ?? dialog.packageId}`
            : dialog.kind === "uninstall"
              ? `Uninstall ${targetRow?.title ?? dialog.packageId}`
              : `Delete retained data for ${targetRow?.title ?? dialog.packageId}`,
  );
</script>

<main class="modules" data-testid="modules" aria-labelledby="modules-title">
  <header>
    <p class="eyebrow">Optional modules</p>
    <h1 id="modules-title" tabindex="-1">Modules</h1>
    <p class="generation" data-testid="modules-generation">
      <strong>{view.generationLabel}</strong>
      {#if view.generationReason}<span>— {view.generationReason}</span>{/if}
    </p>
    {#if snapshot.engine !== "ready"}
      <p class="banner" role="alert" data-testid="modules-engine-unavailable">
        {snapshot.engine === "stale"
          ? "Engine state is stale. This cached view is read-only; module changes are disabled."
          : "Engine unavailable. This cached view is read-only; module changes are disabled."}
        {snapshot.engineReason ? ` ${snapshot.engineReason}` : ""}
      </p>
    {/if}
  </header>

  <section aria-labelledby="catalog-title" class="panel">
    <h2 id="catalog-title">Catalog</h2>
    <p data-testid="modules-catalog-label">
      <strong>{view.catalogLabel}</strong>
      <span class="detail">{view.catalogDetail}</span>
    </p>
    {#if view.catalogUnavailableReason}
      <p class="banner" role="alert" data-testid="modules-catalog-unavailable">
        Catalog unavailable: {view.catalogUnavailableReason}. Installed modules
        stay manageable; adding modules needs a deliberate refresh.
      </p>
    {/if}
    <div class="actions">
      <button
        type="button"
        disabled={!addState.enabled}
        title={addState.reason ?? undefined}
        aria-describedby={addState.reason ? "add-reason" : undefined}
        onclick={() => openDialog({ kind: "add" })}
        data-testid="add-module"
      >
        Add module
      </button>
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
    </div>
    {#if addState.reason}
      <p id="add-reason" class="reason" role="status" data-testid="add-reason">
        {addState.reason}
      </p>
    {/if}
  </section>

  {#if operation}
    <section
      aria-labelledby="operation-title"
      class="panel"
      data-testid="modules-operation"
    >
      <h2 id="operation-title">Operation</h2>
      <p>
        {operation.kindLabel} · {operation.stageLabel} ·
        <code>{operation.operationId}</code>
      </p>
      <p role="status" data-testid="modules-operation-message">
        {operation.message}
      </p>
      {#if operation.progressLabel}
        <progress
          aria-label="Operation progress"
          value={operation.progressValue ?? undefined}
          max="1"
        ></progress>
        <p>{operation.progressLabel}</p>
      {/if}
      {#if operation.outcomeLabel}
        <p
          role={operation.outcomeTone === "negative" ? "alert" : "status"}
          data-testid="modules-operation-outcome"
          data-tone={operation.outcomeTone}
        >
          Outcome: {operation.outcomeLabel}
        </p>
      {/if}
      {#if operation.cleanupLabel}
        <p class="banner" role="alert">{operation.cleanupLabel}</p>
      {/if}
      <div class="actions">
        {#if !operation.terminal}
          <button
            type="button"
            disabled={!operation.canCancel.enabled}
            title={operation.canCancel.reason ?? undefined}
            onclick={cancelOperation}
            data-testid="modules-cancel-operation"
          >
            Cancel this operation
          </button>
        {:else}
          <button
            type="button"
            disabled={!operation.canRetry.enabled}
            title={operation.canRetry.reason ?? undefined}
            onclick={retryOperation}
            data-testid="modules-retry-operation"
          >
            Retry reconciled operation
          </button>
        {/if}
      </div>
      {#if !operation.terminal && operation.canCancel.reason}
        <p class="reason">{operation.canCancel.reason}</p>
      {/if}
      {#if operation.terminal && operation.canRetry.reason}
        <p class="reason">{operation.canRetry.reason}</p>
      {/if}
    </section>
  {/if}

  <section aria-labelledby="installed-title" class="panel">
    <h2 id="installed-title">Installed state</h2>
    {#if view.rows.length === 0}
      <p role="status" data-testid="modules-empty">{view.emptyLabel}</p>
    {:else}
      <ul class="module-rows">
        {#each view.rows as row (row.packageId)}
          {@const optional = optionalState(row)}
          <li data-testid="module-row" data-package-id={row.packageId}>
            <header class="row-header">
              <h3>{row.title}</h3>
              <span class="badge" data-state={row.packageState}>
                {row.packageStateLabel}
              </span>
            </header>
            <dl>
              <dt>Requested</dt><dd>{row.requestedLabel}</dd>
              <dt>Effective</dt><dd data-testid="row-effective">{row.effectiveLabel}</dd>
              <dt>Readiness</dt>
              <dd data-testid="row-readiness">
                {row.readinessReason ?? "No readiness problem reported."}
              </dd>
              <dt>Revision</dt><dd>{row.revisionLabel}</dd>
              <dt>Source</dt><dd>{row.sourceLabel}</dd>
              <dt>Digest</dt><dd><code>{row.digestLabel}</code></dd>
              <dt>License</dt><dd>{row.licenseLabel}</dd>
              <dt>Dependencies</dt><dd>{row.dependenciesLabel}</dd>
              <dt>Dependants</dt><dd>{row.requiredByLabel}</dd>
              <dt>Shared owners</dt><dd data-testid="shared-deps">{row.sharedLabel}</dd>
              <dt>Retained data</dt>
              <dd data-testid="retained-data">{row.retainedLabel}</dd>
            </dl>
            {#if optional}
              <div class="row-help" data-testid="module-row-help">
                <OptionalStateHelp state={optional} feature={row.title} />
              </div>
            {/if}
            {#if row.cleanupLabel}
              <p class="banner" role="alert">{row.cleanupLabel}</p>
            {/if}
            <div class="actions">
              <button
                type="button"
                disabled={!row.enable.enabled}
                title={row.enable.reason ?? undefined}
                onclick={() => openDialog({ kind: "enable", packageId: row.packageId })}
                data-testid="enable-module"
              >
                Enable
              </button>
              <button
                type="button"
                disabled={!row.disable.enabled}
                title={row.disable.reason ?? undefined}
                onclick={() => openDialog({ kind: "disable", packageId: row.packageId })}
                data-testid="disable-module"
              >
                Disable
              </button>
              <button
                type="button"
                disabled={!row.uninstall.enabled}
                title={row.uninstall.reason ?? undefined}
                onclick={() => openDialog({ kind: "uninstall", packageId: row.packageId })}
                data-testid="uninstall-module"
              >
                Uninstall
              </button>
              <button
                type="button"
                disabled={!row.deleteData.enabled}
                title={row.deleteData.reason ?? undefined}
                onclick={() => openDialog({ kind: "delete-data", packageId: row.packageId })}
                data-testid="delete-data"
              >
                Delete retained data
              </button>
            </div>
            {#if row.enable.reason}
              <p class="reason">Enable unavailable: {row.enable.reason}</p>
            {/if}
            {#if row.disable.reason}
              <p class="reason">Disable unavailable: {row.disable.reason}</p>
            {/if}
            {#if row.uninstall.reason}
              <p class="reason">Uninstall unavailable: {row.uninstall.reason}</p>
            {/if}
            {#if row.deleteData.reason}
              <p class="reason">Delete data unavailable: {row.deleteData.reason}</p>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  {#if snapshot.generation.state === "unconfigured"}
    <p class="panel note" data-testid="modules-generation-note">
      <strong>{view.generationLabel}.</strong> {view.generationReason} Installing
      or enabling a module does not configure generation, download weights or
      choose a fallback.
      <button type="button" onclick={onConfigureProvider} data-testid="modules-configure-provider">
        Configure a provider or model
      </button>
    </p>
  {/if}
</main>

{#if dialog}
  <div class="backdrop">
    <div
      class="dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="module-dialog-title"
      tabindex="-1"
      bind:this={dialogEl}
      onkeydown={onDialogKeydown}
      data-testid="module-dialog"
      data-kind={dialog.kind}
    >
      <h2 id="module-dialog-title">{dialogTitle}</h2>

      {#if dialog.kind === "add"}
        <p>
          Selections start empty. Reviewing hands the exact roots to the same
          install review used by setup; nothing is fetched or installed here.
        </p>
        {#if view.catalogUnavailableReason}
          <p class="banner" role="alert">
            Catalog unavailable: {view.catalogUnavailableReason}. This is not an
            empty successful catalog.
          </p>
        {:else if snapshot.entries.length === 0}
          <p role="status">The cached catalog lists no optional modules.</p>
        {:else}
          <ul class="add-list">
            {#each snapshot.entries as entry (entry.packageId)}
              {@const option = catalogEntryView(entry)}
              <li data-testid="add-option" data-package-id={entry.packageId}>
                <label class="check">
                  <input
                    type="checkbox"
                    checked={addSelected.includes(entry.packageId)}
                    disabled={!option.selectable}
                    onchange={(event) =>
                      toggleAdd(
                        entry.packageId,
                        (event.currentTarget as HTMLInputElement).checked,
                      )}
                  />
                  <span>
                    <strong>{option.title}</strong>
                    <span class="detail">{option.summary}</span>
                  </span>
                </label>
                {#if option.selectBlockedReason}
                  <p class="blocker" role="alert">{option.selectBlockedReason}</p>
                {/if}
                {#if !option.selectable}
                  <OptionalStateHelp state="unsupported" feature={option.title} />
                {/if}
                <dl>
                  <dt>Source</dt><dd>{option.sourceLabel}</dd>
                  <dt>Digest</dt><dd><code>{option.digestLabel}</code></dd>
                  <dt>License</dt><dd>{option.licenseLabel}</dd>
                  <dt>Compatibility</dt><dd>{option.compatibilityLabel}</dd>
                  <dt>Download</dt><dd>{option.downloadLabel}</dd>
                  <dt>Installed size</dt><dd>{option.installedLabel}</dd>
                  <dt>Dependencies</dt><dd>{option.dependencyLabel}</dd>
                </dl>
                {#if option.setupExecutionLabel}
                  <p>{option.setupExecutionLabel}</p>
                {/if}
                {#if option.modelLabel}<p>{option.modelLabel}</p>{/if}
              </li>
            {/each}
          </ul>
        {/if}
        <p class="reason" role="status">
          {addSelection.reason ?? `${addSelected.length} module(s) selected.`}
        </p>
      {:else if installedTarget && targetRow}
        <dl class="facts">
          <dt>Package</dt><dd>{targetRow.packageStateLabel}</dd>
          <dt>Requested</dt><dd>{targetRow.requestedLabel}</dd>
          <dt>Effective</dt><dd>{targetRow.effectiveLabel}</dd>
          <dt>Readiness</dt>
          <dd>{targetRow.readinessReason ?? "No readiness problem reported."}</dd>
        </dl>

        {#if dialog.kind === "enable"}
          <p>
            Enabling never installs, enables or selects a dependency
            automatically. Model provisioning stays separate.
          </p>
          {#if dialogBlockers.length > 0}
            <div class="banner" role="alert" data-testid="dialog-blocker">
              <p>Enable is blocked until these dependencies are enabled:</p>
              <ul>
                {#each dialogBlockers as blocker (blocker)}<li>{blocker}</li>{/each}
              </ul>
            </div>
          {/if}
          {#if targetEntry?.model}
            <p data-testid="dialog-model">
              Required model <strong>{targetEntry.model}</strong> is not provided
              by this action. The module stays unconfigured until you select or
              provision it separately; no weights are downloaded and no fallback
              is chosen.
            </p>
          {/if}
        {:else if dialog.kind === "disable"}
          <p>
            Disable fences new admission and drains owned work before effective
            off. It does not uninstall the package, remove shared dependencies or
            delete retained data.
          </p>
        {:else if dialog.kind === "uninstall"}
          <p>
            Uninstall removes owned package code only. It does not delete
            retained data, remove shared dependencies or delete external sources.
          </p>
          <p data-testid="dialog-shared">
            {targetRow.sharedLabel}. {targetRow.requiredByLabel}.
          </p>
          <p data-testid="dialog-retained">
            Kept after uninstall: {targetRow.retainedLabel}. Delete it as a
            separate deliberate action.
          </p>
          <button
            type="button"
            disabled={!targetRow.deleteData.enabled}
            title={targetRow.deleteData.reason ?? undefined}
            onclick={() => openDeleteData(installedTarget.packageId)}
            data-testid="open-delete-data"
          >
            Delete retained data separately
          </button>
        {:else}
          <p>
            This deletes retained data only. It does not uninstall package code,
            delete workspace source, remove imported originals or stop shared
            services.
          </p>
          <p data-testid="delete-data-list">{targetRow.retainedLabel}</p>
          {#if targetRow.cleanupLabel}
            <p class="banner" role="alert">{targetRow.cleanupLabel}</p>
          {/if}
        {/if}

        {#if dialogAction && !dialogAction.enabled}
          <p class="reason" role="status" data-testid="dialog-reason">
            {dialogAction.reason}
          </p>
        {/if}
      {:else}
        <p role="alert" data-testid="dialog-missing">
          The engine no longer reports this module. Nothing has been changed.
        </p>
      {/if}

      <div class="actions">
        <button
          type="button"
          data-autofocus
          onclick={closeDialog}
          data-testid="dialog-cancel"
        >
          Cancel
        </button>
        {#if dialog.kind === "add"}
          <button
            type="button"
            disabled={!addSelection.enabled}
            title={addSelection.reason ?? undefined}
            onclick={reviewAdd}
            data-testid="dialog-review-add"
          >
            Review selected modules
          </button>
        {:else if dialogAction}
          <button
            type="button"
            disabled={!dialogAction.enabled}
            title={dialogAction.reason ?? undefined}
            onclick={confirmDialog}
            data-testid="dialog-confirm"
          >
            {dialog.kind === "enable"
              ? "Enable"
              : dialog.kind === "disable"
                ? "Disable"
                : dialog.kind === "uninstall"
                  ? "Uninstall"
                  : "Delete retained data"}
          </button>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .modules {
    max-width: 960px;
    margin: 0 auto;
    padding: 24px;
    box-sizing: border-box;
    color: #111827;
  }
  h1 {
    margin: 4px 0 8px;
    font-size: 1.5rem;
  }
  h1:focus-visible {
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
  .panel {
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    padding: 16px;
    margin-top: 16px;
    background: #ffffff;
  }
  .panel h2 {
    margin-top: 0;
    font-size: 1.125rem;
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
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 12px;
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
  input:focus-visible,
  .dialog:focus-visible {
    outline: 2px solid currentColor;
    outline-offset: 2px;
  }
  .module-rows {
    list-style: none;
    padding: 0;
    margin: 0;
    display: grid;
    gap: 12px;
  }
  .module-rows > li {
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    padding: 12px;
  }
  .row-header {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .row-help {
    margin-top: 8px;
  }
  .row-header h3 {
    margin: 0;
    font-size: 1rem;
  }
  .badge {
    padding: 2px 8px;
    border-radius: 9999px;
    background: #f3f4f6;
    color: #374151;
    font-size: 0.75rem;
    font-weight: 700;
    text-transform: uppercase;
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
  .reason,
  .blocker {
    color: #991b1b;
    font-size: 0.8125rem;
    margin: 8px 0 0;
  }
  .note button {
    margin-left: 8px;
  }
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(17, 24, 39, 0.45);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding: 24px;
    overflow: auto;
    box-sizing: border-box;
  }
  .dialog {
    background: #ffffff;
    color: #111827;
    border-radius: 8px;
    padding: 20px;
    width: min(720px, 100%);
    box-sizing: border-box;
  }
  .dialog h2 {
    margin-top: 0;
  }
  .add-list {
    list-style: none;
    padding: 0;
    margin: 12px 0;
    display: grid;
    gap: 12px;
  }
  .add-list > li {
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    padding: 12px;
  }
  .check {
    display: flex;
    gap: 8px;
    align-items: flex-start;
  }
</style>
