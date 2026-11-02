<script lang="ts">
  import { tick, type Snippet } from "svelte";
  import Mark from "./Mark.svelte";
  import Icon from "./Icon.svelte";
  import type { IconName } from "./icons";

  type View = "work" | "runs" | "memory" | "models" | "extensions" | "settings";
  let {
    view,
    onNavigate,
    workspaceName,
    choosing,
    projectUnavailable,
    projectStatus,
    onChooseProject,
    engineReady,
    engineStatus,
    onNewChat,
    newChatUnavailable,
    effectiveMode,
    children,
  }: {
    view: View;
    onNavigate: (view: View) => void;
    workspaceName?: string;
    choosing: boolean;
    projectUnavailable: boolean;
    projectStatus: string | null;
    onChooseProject: () => void;
    engineReady: boolean;
    engineStatus: string;
    onNewChat: () => void;
    newChatUnavailable: boolean;
    effectiveMode: string;
    children: Snippet;
  } = $props();
  const pages: { id: View; label: string; icon: IconName }[] = [
    { id: "work", label: "Work", icon: "terminal" },
    { id: "runs", label: "Runs", icon: "clock" },
    { id: "memory", label: "Memory", icon: "database" },
    { id: "models", label: "Models", icon: "cpu" },
    { id: "extensions", label: "Extensions", icon: "layers" },
    { id: "settings", label: "Settings", icon: "settings" },
  ];
  let collapsed = $state(
    typeof localStorage !== "undefined" &&
      localStorage.getItem("splyce.sidebar") === "closed",
  );
  let mobileOpen = $state(false);
  let width = $state(window.innerWidth);
  let theme = $state<"light" | "dark">("light");
  let toggleButton: HTMLButtonElement;
  let mobileButton: HTMLButtonElement;
  let closeButton: HTMLButtonElement;
  const narrow = $derived(width <= 820);
  const hidden = $derived(narrow ? !mobileOpen : collapsed);

  function toggleTheme() {
    theme = theme === "light" ? "dark" : "light";
  }
  $effect(() => {
    document.documentElement.dataset.theme = theme;
  });

  async function toggleSidebar() {
    if (narrow) mobileOpen = !mobileOpen;
    else collapsed = !collapsed;
    if (!narrow && typeof localStorage !== "undefined") {
      localStorage.setItem("splyce.sidebar", collapsed ? "closed" : "open");
    }
    await tick();
    if (narrow && mobileOpen) closeButton?.focus();
    else if (narrow) mobileButton?.focus();
    else toggleButton?.focus();
  }
  async function navigate(next: View) {
    onNavigate(next);
    if (mobileOpen) {
      mobileOpen = false;
      await tick();
      mobileButton?.focus();
    }
  }
  async function resize() {
    const inSidebar = document
      .getElementById("app-sidebar")
      ?.contains(document.activeElement);
    width = window.innerWidth;
    if (!narrow) mobileOpen = false;
    await tick();
    if (inSidebar && hidden) (narrow ? mobileButton : toggleButton)?.focus();
  }
  function keydown(event: KeyboardEvent) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n") {
      event.preventDefault();
      if (!newChatUnavailable) onNewChat();
    }
    if (event.key === "Tab" && narrow && mobileOpen) {
      const controls = [
        ...document.querySelectorAll<HTMLButtonElement>(
          "#app-sidebar button:not(:disabled)",
        ),
      ];
      const first = controls[0];
      const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "b") {
      event.preventDefault();
      void toggleSidebar();
    }
    if (
      (event.ctrlKey || event.metaKey) &&
      event.shiftKey &&
      event.key.toLowerCase() === "l"
    ) {
      event.preventDefault();
      toggleTheme();
    }
    if (event.key === "Escape" && mobileOpen) {
      event.preventDefault();
      void toggleSidebar();
    }
  }
</script>

<svelte:window onkeydown={keydown} onresize={() => void resize()} />

<div class="app" class:side-collapsed={collapsed}>
  <button
    class="side-tab"
    type="button"
    bind:this={toggleButton}
    aria-label={collapsed ? "Open sidebar" : "Collapse sidebar"}
    aria-expanded={!hidden}
    aria-controls="app-sidebar"
    aria-keyshortcuts="Control+B"
    onclick={() => void toggleSidebar()}
  >
    <Icon name={collapsed ? "chevron-right" : "chevron-left"} size={15} />
  </button>
  <aside
    class="side"
    class:collapsed
    class:open={mobileOpen}
    id="app-sidebar"
    inert={hidden}
  >
    <button
      class="side-close icon-btn"
      type="button"
      aria-label="Close navigation"
      bind:this={closeButton}
      onclick={() => void toggleSidebar()}><Icon name="x" size={18} /></button
    >
    <button
      class="brand"
      type="button"
      onclick={() => void navigate("work")}
      aria-label="Splyce home"><Mark size={22} />Splyce</button
    >
    <button
      class="ws"
      type="button"
      aria-label="Choose project"
      disabled={projectUnavailable || choosing}
      aria-describedby="project-status"
      onclick={onChooseProject}
    >
      <span class="ws-badge"><Icon name="folder" size={12} /></span>
      <span class="ws-name" data-testid="project-name"
        >{choosing ? "Choosing…" : (workspaceName ?? "Choose project")}</span
      ><Icon name="chevron-down" size={13} />
    </button>
    <p class="project-status" id="project-status" role="status">
      {projectStatus}
    </p>
    <button
      type="button"
      class="nav-item"
      disabled={newChatUnavailable}
      onclick={onNewChat}
      aria-keyshortcuts="Control+N">+ New chat</button
    >
    <nav class="nav" aria-label="Workspace">
      {#each pages as page (page.id)}
        <button
          type="button"
          class="nav-item"
          class:active={view === page.id}
          aria-current={view === page.id ? "page" : undefined}
          onclick={() => void navigate(page.id)}
          ><span class="n-ico"><Icon name={page.icon} size={15} /></span
          >{page.label}</button
        >
      {/each}
    </nav>
    <div class="side-foot">
      <div class="side-foot-row">
        <span class="side-status" role="status"
          ><span class="dot" class:unavailable={!engineReady}
          ></span>{engineStatus}</span
        ><button
          class="icon-btn"
          type="button"
          aria-label={theme === "light"
            ? "Switch to dark theme"
            : "Switch to light theme"}
          aria-keyshortcuts="Control+Shift+L"
          onclick={toggleTheme}
          ><Icon name={theme === "light" ? "moon" : "sun"} size={14} /></button
        >
      </div>
      <div class="fine">No cloud fallback · AGPL-3.0</div>
    </div>
  </aside>
  {#if mobileOpen && narrow}<button
      type="button"
      class="scrim"
      tabindex="-1"
      aria-label="Close navigation"
      onclick={() => void toggleSidebar()}
    ></button>{/if}
  <main
    class="main"
    aria-label={pages.find((p) => p.id === view)?.label}
    inert={mobileOpen && narrow}
  >
    <div class="mobile-bar">
      <button
        class="mb-brand"
        type="button"
        aria-label="Splyce home"
        onclick={() => void navigate("work")}><Mark size={19} />Splyce</button
      ><button
        class="mb-menu"
        type="button"
        bind:this={mobileButton}
        aria-label="Open navigation"
        aria-expanded={mobileOpen}
        aria-controls="app-sidebar"
        onclick={() => void toggleSidebar()}
        ><Icon name="menu" size={18} /></button
      >
    </div>
    <div
      class="permission-badge"
      class:warning={effectiveMode === "Bypass (unsafe)"}
      role="status"
      data-testid="effective-mode-badge"
    >
      Permission: {effectiveMode}
    </div>
    {@render children()}
  </main>
</div>

<style>
  .permission-badge {
    align-self: flex-start;
    margin: 0.75rem 1.5rem 0;
    padding: 0.25rem 0.6rem;
    border: 1px solid var(--border);
    border-radius: 999px;
    font-size: 0.75rem;
  }
  .permission-badge.warning {
    color: var(--status-warning);
    background: var(--warning-soft);
    border-color: var(--warning-border);
    font-weight: 600;
  }
  @media (forced-colors: active) {
    .permission-badge.warning {
      border-color: currentColor;
    }
  }
</style>
