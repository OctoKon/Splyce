<script lang="ts">
  import { PROPOSED_SELECTION } from "../specimens/tokens";
  import type { SpecialistView } from "../../stores/specialist-view";

  let { view }: { view: SpecialistView } = $props();

  const title = $derived(
    view.kind === "decision" ? "Decision advice" : "Forecast advice",
  );
</script>

<section class="specialist" aria-label={title} data-testid="specialist-advice">
  <header>
    <h3>{title}</h3>
    <p class="badges">
      <span
        class="advisory"
        style:background={PROPOSED_SELECTION.selection}
        style:color={PROPOSED_SELECTION.selectionText}
        data-testid="specialist-advisory">Advisory only</span
      >
      {#if view.fixture}
        <span class="fixture" data-testid="specialist-fixture"
          >Fixture data</span
        >
      {/if}
    </p>
  </header>

  <p class="authority">
    This advice does not grant authority, approve actions, or enable a
    scheduler.
  </p>

  {#if view.bindingUnavailableReason}
    <p class="unavailable" role="status" data-testid="specialist-unavailable">
      {view.bindingUnavailableReason}
    </p>
  {:else if view.advice}
    <h4>{view.advice.headline}</h4>
    <p>{view.advice.detail}</p>
    {#if view.advice.abstained}
      <p class="abstained" role="status" data-testid="specialist-abstained">
        The model abstained; no recommendation is implied.
      </p>
    {:else if view.calibration.confidence !== null}
      <p data-testid="specialist-confidence">
        Calibrated confidence: {Math.round(
          view.calibration.confidence * 100,
        )}%
      </p>
    {/if}
  {:else}
    <p role="status" data-testid="specialist-no-advice">
      No advice was supplied; nothing is implied.
    </p>
  {/if}

  <dl class="calibration" aria-label="Calibration and binding">
    <dt>Binding</dt>
    <dd data-testid="specialist-binding">
      {view.bindingState === "ready" ? "Ready" : "Unavailable"}
    </dd>
    <dt>Calibration</dt>
    <dd data-testid="specialist-calibration">{view.calibration.label}</dd>
    <dt>Calibration detail</dt>
    <dd>{view.calibration.detail}</dd>
    <dt>Model</dt>
    <dd>{view.model.name} ({view.model.revision})</dd>
  </dl>

  <details>
    <summary>Technical detail</summary>
    <p>
      Specialist advice is advisory presentation only; it is not an approval, a
      policy decision, or proof of completion.
    </p>
  </details>
</section>

<style>
  .specialist {
    background: var(--surface, #ffffff);
    color: var(--text, #1a1a1a);
    border: 1px solid var(--border, #767676);
    padding: 16px;
    overflow-wrap: anywhere;
  }
  h3,
  h4 {
    margin-top: 0;
  }
  .badges {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin: 0;
  }
  .advisory,
  .fixture {
    display: inline-block;
    padding: 2px 8px;
    font-weight: 600;
  }
  .fixture {
    border: 1px dashed currentColor;
  }
  .authority {
    font-weight: 600;
  }
  .calibration {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 4px 12px;
  }
  dt {
    font-weight: 600;
  }
  details {
    margin-top: 12px;
  }
  summary {
    cursor: pointer;
  }
</style>
