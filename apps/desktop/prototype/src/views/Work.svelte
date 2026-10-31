<script lang="ts">
  import { app } from '../lib/state.svelte';
  import { workspaces } from '../lib/data';
  import Composer from '../lib/Composer.svelte';
  import Picker from '../lib/Picker.svelte';

  let prompt = $state('');
  let base = $state('main');
  let model = $state('Qwen3-Coder-30B-A3B');

  function start(text: string) {
    app.createRun(text, app.workspaceId, `${base}@a3f91c2`, model);
    prompt = '';
    app.toast('Run created · approvals stay on');
  }
</script>

<div class="page work-page">
  <div class="work-stage">
    <p class="work-line">
      What are we <em>building</em> today?
    </p>

    <Composer
      bind:value={prompt}
      placeholder="Describe the task, the acceptance test, and anything that must not change…"
      onsend={start}
    >
      <Picker
        label="runtime"
        icon="cpu"
        value={model}
        options={[
          { value: 'Qwen3-Coder-30B-A3B', label: 'Pi · Qwen3-Coder' },
          { value: 'Devstral-Small-24B', label: 'Pi · Devstral' },
        ]}
        onchange={(value) => (model = value)}
      />
    </Composer>

    <div class="work-meta">
      <Picker
        label="workspace"
        icon="folder"
        value={app.workspaceId}
        options={workspaces.map((workspace) => ({ value: workspace.id, label: workspace.name }))}
        onchange={(value) => app.setWorkspace(value)}
      />
      <Picker
        label="git"
        icon="branch"
        value={base}
        options={[
          { value: 'main', label: 'main', note: 'a3f91c2' },
          { value: 'release/1.4', label: 'release/1.4', note: 'b81d003' },
          { value: 'splyce/retry-loop', label: 'splyce/retry-loop', note: 'unverified' },
        ]}
        onchange={(value) => (base = value)}
      />
    </div>
  </div>
</div>

<style>
  .work-page {
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .work-stage {
    flex: 1;
    display: flex;
    flex-direction: column;
    justify-content: center;
    padding-bottom: 6vh;
  }
  .work-line {
    margin: 0 auto 24px;
    font-family: var(--serif);
    font-size: clamp(26px, 3.4vw, 42px);
    font-weight: 400;
    line-height: 1.15;
    letter-spacing: -0.015em;
    color: var(--text-muted);
    text-align: center;
  }
  .work-line em {
    font-style: italic;
    color: var(--on-surface);
  }
  .work-meta {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    flex-wrap: wrap;
    width: min(100%, 720px);
    margin: 10px auto 0;
  }
  @media (min-width: 821px) {
    .work-stage {
      padding-top: 6vh;
      padding-bottom: 0;
    }
  }
</style>
