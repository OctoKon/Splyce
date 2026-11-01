<script lang="ts">
  export type SetupOption = "base-only" | "optional-modules" | "skip-setup";

  export interface SetupResult {
    option: SetupOption;
    selectedModules?: string[];
  }

  let {
    defaultOption = "base-only",
    onSetupOption,
  }: {
    defaultOption?: SetupOption;
    onSetupOption?: (result: SetupResult) => void;
  } = $props();

  function handleOption(option: SetupOption) {
    onSetupOption?.({ option });
  }

  function handleKeydown(event: KeyboardEvent, option: SetupOption) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    handleOption(option);
  }
</script>

<section
  class="setup-flow"
  data-testid="setup-flow"
  aria-labelledby="setup-title"
>
  <h3 id="setup-title">
    {defaultOption === "skip-setup" ? "Skip Setup" : "Welcome to Splyce Setup"}
  </h3>

  <p class="setup-description">
    Choose how you'd like to start using Splyce. You can begin with the base
    installation, select optional modules, or skip setup entirely to access the
    workbench later.
  </p>

  <div class="setup-options">
    <!-- Base-only option -->
    <div
      class="setup-option"
      onclick={() => handleOption("base-only")}
      data-testid="setup-base"
      role="button"
      tabindex="0"
      onkeydown={(event) => handleKeydown(event, "base-only")}
    >
      <span class="setup-icon">🏠</span>
      <div>
        <h4>Continue with base only</h4>
        <p>
          Start with the core Splyce engine and default settings. Optional
          modules can be added later.
        </p>
      </div>
    </div>

    <!-- Optional modules option -->
    <div
      class="setup-option"
      onclick={() => handleOption("optional-modules")}
      data-testid="setup-modules"
      role="button"
      tabindex="0"
      onkeydown={(event) => handleKeydown(event, "optional-modules")}
    >
      <span class="setup-icon">⚙️</span>
      <div>
        <h4>Choose optional modules</h4>
        <p>
          Select additional features and integrations for your Splyce setup.
        </p>
      </div>
    </div>

    <!-- Skip setup option -->
    <div
      class="setup-option"
      onclick={() => handleOption("skip-setup")}
      data-testid="setup-skip"
      role="button"
      tabindex="0"
      onkeydown={(event) => handleKeydown(event, "skip-setup")}
    >
      <span class="setup-icon">⏭️</span>
      <div>
        <h4>Skip setup</h4>
        <p>
          Enter the workbench directly without setup. Settings are accessible
          from the menu.
        </p>
      </div>
    </div>
  </div>
</section>

<style>
  .setup-flow {
    border: 1px solid var(--border, #e5e7eb);
    border-radius: var(--radius-md, 8px);
    padding: 24px;
    margin: 24px 0;
    max-width: 600px;
  }

  .setup-flow h3 {
    margin: 0 0 16px;
    font-size: 1.25rem;
    font-weight: 600;
    color: var(--foreground, #111827);
  }

  .setup-description {
    margin: 0 0 20px;
    font-size: 0.875rem;
    color: var(--text-secondary, #6b7280);
    line-height: 1.5;
  }

  .setup-options {
    display: grid;
    gap: 12px;
  }

  .setup-option {
    border: 1px solid var(--border, #d1d5db);
    border-radius: var(--radius-md, 8px);
    padding: 16px;
    cursor: pointer;
    transition: all 0.2s ease;
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: 12px;
  }

  .setup-option:hover {
    border-color: var(--primary, #3b82f6);
    background-color: var(--setup-option-hover, #f3f4f6);
  }

  .setup-option:focus-visible {
    outline: 2px solid var(--primary, #3b82f6);
    outline-offset: 2px;
  }

  .setup-option[data-testid="setup-base"]:focus-visible {
    outline: 2px solid #10b981;
    outline-offset: 2px;
  }

  .setup-option[data-testid="setup-modules"]:focus-visible {
    outline: 2px solid #f59e0b;
    outline-offset: 2px;
  }

  .setup-option[data-testid="setup-skip"]:focus-visible {
    outline: 2px solid #6b7280;
    outline-offset: 2px;
  }

  .setup-icon {
    font-size: 1.5rem;
    margin-right: 8px;
  }

  .setup-option h4 {
    margin: 0 0 4px;
    font-size: 1rem;
    font-weight: 500;
  }

  .setup-option p {
    margin: 0;
    font-size: 0.75rem;
    color: var(--text-secondary, #6b7280);
  }
</style>
