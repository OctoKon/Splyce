<script lang="ts">
  import {
    createCommandRegistry,
    type CommandHandler,
  } from "../../stores/commands";
  import CommandPalette from "./CommandPalette.svelte";

  interface Props {
    /** Admitted action handlers keyed by catalog id; palette.open is supplied here. */
    handlers: Readonly<Record<string, CommandHandler>>;
    scopeLabel: string;
  }
  let { handlers, scopeLabel }: Props = $props();

  let open = $state(false);
  let failure = $state("");
  // Handlers are read at call time so a changed prop is never stale.
  const registry = createCommandRegistry(
    new Proxy(
      {
        "palette.open": {
          run: () => {
            open = true;
          },
        },
      } as Record<string, CommandHandler>,
      { get: (own, id: string) => own[id] ?? handlers[id], has: () => true },
    ),
    undefined,
    (id, reason) => {
      failure = `${id}: ${reason}`;
    },
  );
</script>

<svelte:window onkeydown={(e) => registry.handleKey(e)} />
<p role="alert">{failure}</p>
<CommandPalette {registry} bind:open {scopeLabel} />
