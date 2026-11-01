<script lang="ts">
  import { onMount } from "svelte";
  import Setup from "../../src/routes/Setup.svelte";
  import Modules from "../../src/routes/Modules.svelte";
  import {
    d1BaseSetup,
    d6Reviewing,
    d6ReviewingStale,
    engineUnavailable,
    w10Modules,
    w10ReadyForEnable,
  } from "./fixtures";
  import type { ModuleSnapshot } from "../../src/stores/modules";
  import type { Td29Case } from "./cases";

  interface Props {
    case?: Td29Case;
  }

  let { case: caseName = "d1-setup" }: Props = $props();

  type Call = { readonly name: string; readonly args: readonly unknown[] };

  let calls = $state<Call[]>([]);

  function record(name: string) {
    return (...args: unknown[]) => {
      calls = [...calls, { name, args }];
    };
  }

  const snapshot = $derived<ModuleSnapshot>(
    caseName === "d6-setup"
      ? d6Reviewing
      : caseName === "d6-stale"
        ? d6ReviewingStale
        : caseName === "w10-modules"
          ? w10Modules
          : caseName === "w10-ready"
            ? w10ReadyForEnable
            : caseName === "offline-modules"
              ? d1BaseSetup
              : caseName === "unavailable-modules"
                ? engineUnavailable
                : d1BaseSetup,
  );

  const mode = $derived(caseName.endsWith("modules") ? "modules" : "setup");

  onMount(() => {
    (
      window as unknown as {
        __td29: {
          case: Td29Case;
          calls: () => readonly Call[];
          lastCall: () => Call | null;
          clear: () => void;
        };
      }
    ).__td29 = {
      case: caseName,
      calls: () => calls,
      lastCall: () => calls.at(-1) ?? null,
      clear: () => {
        calls = [];
      },
    };
  });
</script>

{#if mode === "modules"}
  <Modules
    {snapshot}
    onRefreshCatalog={record("onRefreshCatalog")}
    onAdd={record("onAdd")}
    onEnable={record("onEnable")}
    onDisable={record("onDisable")}
    onUninstall={record("onUninstall")}
    onDeleteData={record("onDeleteData")}
    onCancelOperation={record("onCancelOperation")}
    onRetryOperation={record("onRetryOperation")}
    onConfigureProvider={record("onConfigureProvider")}
  />
{:else}
  <Setup
    {snapshot}
    initialStep={caseName === "d1-setup" ? "start" : "selecting"}
    onBaseOnly={record("onBaseOnly")}
    onSkip={record("onSkip")}
    onRefreshCatalog={record("onRefreshCatalog")}
    onReview={record("onReview")}
    onConfirmInstall={record("onConfirmInstall")}
    onCancelOperation={record("onCancelOperation")}
    onRetryOperation={record("onRetryOperation")}
    onOpenModules={record("onOpenModules")}
    onConfigureProvider={record("onConfigureProvider")}
    onEnterWorkbench={record("onEnterWorkbench")}
  />
{/if}
