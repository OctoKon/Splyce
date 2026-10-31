<script lang="ts">
  import { onDestroy } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import { fade, slide } from 'svelte/transition';
  import { app } from '../lib/state.svelte';
  import { memoryItems } from '../lib/data';
  import PageHead from '../lib/PageHead.svelte';
  import Icon from '../lib/Icon.svelte';
  import Chip from '../lib/Chip.svelte';
  import Picker from '../lib/Picker.svelte';

  type Kind = 'all' | 'decision' | 'failure' | 'capsule';

  const kindIcon = { decision: 'check', failure: 'alert', capsule: 'message' } as const;
  const kindLabel = { decision: 'Decision', failure: 'Failure', capsule: 'Capsule' } as const;

  let query = $state('');
  let filter = $state<Kind>('all');
  let scope = $state<'workspace' | 'all'>('workspace');
  let granted = $state(false);
  const expanded = new SvelteSet<string>();
  const removed = new SvelteSet<string>();
  let corrected = $state<Record<string, { title: string; excerpt: string }>>({});
  let editing = $state<string | null>(null);
  let draft = $state('');
  let confirmId = $state<string | null>(null);
  let retention = $state('90');
  let rebuilding = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  onDestroy(() => {
    if (timer) clearTimeout(timer);
  });

  const visible = $derived(
    memoryItems.filter((item) => {
      if (scope === 'workspace' && item.workspace !== app.workspace.name) return false;
      if (scope === 'all' && !granted && item.workspace !== app.workspace.name) return false;
      if (filter !== 'all' && item.kind !== filter) return false;
      const needle = query.trim().toLowerCase();
      if (!needle) return true;
      return (
        item.title.toLowerCase().includes(needle) ||
        item.excerpt.toLowerCase().includes(needle) ||
        item.source.toLowerCase().includes(needle) ||
        item.runId.includes(needle)
      );
    }),
  );

  const counts = $derived.by(() => {
    const base = { all: 0, decision: 0, failure: 0, capsule: 0 };
    for (const item of memoryItems) {
      if (scope === 'workspace' && item.workspace !== app.workspace.name) continue;
      if (scope === 'all' && !granted && item.workspace !== app.workspace.name) continue;
      base.all += 1;
      base[item.kind] += 1;
    }
    return base;
  });

  function setScope(next: string) {
    scope = next as 'workspace' | 'all';
    if (scope === 'workspace') granted = false;
  }

  function toggleExpand(id: string) {
    if (expanded.has(id)) expanded.delete(id);
    else expanded.add(id);
  }

  function startCorrect(id: string) {
    const item = memoryItems.find((entry) => entry.id === id);
    editing = id;
    draft = corrected[id]?.excerpt ?? item?.excerpt ?? '';
  }

  function saveCorrect(id: string) {
    if (!draft.trim()) return;
    const item = memoryItems.find((entry) => entry.id === id);
    if (!item) return;
    corrected = {
      ...corrected,
      [id]: { title: corrected[id]?.title ?? item.title, excerpt: draft.trim() },
    };
    editing = null;
    app.toast('Memory corrected · new summary revision');
  }

  function forget(id: string) {
    if (confirmId !== id) {
      confirmId = id;
      return;
    }
    removed.add(id);
    confirmId = null;
    app.toast('Forgotten · tombstone keeps no content');
  }

  function exportMemory() {
    const payload = {
      schemaVersion: 1,
      scope: scope === 'workspace' ? app.workspace.name : 'all-workspaces',
      exportedAt: new Date().toISOString(),
      items: memoryItems
        .filter((item) => !removed.has(item.id))
        .map((item) => ({ ...item, ...(corrected[item.id] ?? {}) })),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'splyce-memory-export.json';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    app.toast('Memory exported');
  }

  function rebuild() {
    if (rebuilding) return;
    rebuilding = true;
    timer = setTimeout(() => {
      rebuilding = false;
      app.toast('Embedding index rebuilt · generation 5 validated');
    }, 1600);
  }
</script>

<div class="page">
  <PageHead
    eyebrow={`Local journal · ${app.workspace.name}`}
    title="Memory"
    sub="Cross-session recall with sources. Workspace-scoped by default; every summary can be expanded, corrected or deleted."
  >
    <Picker
      label="scope"
      icon="layers"
      align="right"
      value={scope}
      options={[
        { value: 'workspace', label: app.workspace.name },
        { value: 'all', label: 'All workspaces' },
      ]}
      onchange={setScope}
    />
    <button class="btn secondary" type="button" onclick={exportMemory}>
      <Icon name="download" size={13} /> Export
    </button>
  </PageHead>

  {#if scope === 'all'}
    <div class="callout" transition:fade={{ duration: 160 }}>
      <Icon name={granted ? 'check' : 'lock'} size={15} />
      <div style="flex:1">
        <div class="co-title">
          {granted
            ? 'Cross-workspace recall granted for this session'
            : 'Cross-workspace recall needs a grant'}
        </div>
        <div class="co-body">
          {granted
            ? 'Results include provenance for every source. The grant expires when the app closes and is recorded in the journal.'
            : 'Splyce will not retrieve evidence from another workspace without an explicit scope grant. Nothing is shared by default.'}
        </div>
      </div>
      {#if granted}
        <button
          class="btn sm secondary"
          type="button"
          onclick={() => {
            granted = false;
            scope = 'workspace';
            app.toast('Scope grant revoked');
          }}
        >
          Revoke
        </button>
      {:else}
        <button
          class="btn sm primary"
          type="button"
          onclick={() => {
            granted = true;
            app.toast('Scope grant recorded · session only');
          }}
        >
          Grant for this session
        </button>
      {/if}
    </div>
  {/if}

  <div class="search wide" style="margin-bottom:10px">
    <span class="search-ico"><Icon name="search" size={14} /></span>
    <input
      bind:value={query}
      placeholder="Search decisions, failures and session capsules…"
      aria-label="Search memory"
    />
  </div>

  <div class="filters">
    {#each [['all', 'All'], ['decision', 'Decisions'], ['failure', 'Failures'], ['capsule', 'Capsules']] as [value, label] (value)}
      <button
        class="filter"
        class:on={filter === value}
        type="button"
        onclick={() => (filter = value as Kind)}
      >
        {label} <span class="n">{counts[value as keyof typeof counts]}</span>
      </button>
    {/each}
    <span class="spacer"></span>
    <span class="muted t-micro">{counts.all} items in scope</span>
  </div>

  <div class="cols">
    <div class="mem-list">
      {#if visible.length === 0}
        <div class="empty">No memory matches{query ? ` “${query}”` : ''}.</div>
      {/if}

      {#each visible as item (item.id)}
        {#if removed.has(item.id)}
          <div class="mem removed">
            <div class="mem-top">
              <span class="mem-kind"><Icon name="trash" size={11} /> Forgotten</span>
              <span class="age">{item.age}</span>
            </div>
            <div style="font-size:12px;line-height:19px">
              Tombstone <span class="mono">{item.id}</span> · no content retained. Derived indexes are
              queued for rebuild.
            </div>
          </div>
        {:else}
          <article class="mem">
            <div class="mem-top">
              <span class="mem-kind"
                ><Icon name={kindIcon[item.kind]} size={11} /> {kindLabel[item.kind]}</span
              >
              {#if item.superseded}<Chip tone="outline">{item.superseded}</Chip>{/if}
              {#if corrected[item.id]}<Chip tone="outline" dot>Corrected</Chip>{/if}
              <span class="age">{item.age}</span>
            </div>
            <h3 class:superseded={!!item.superseded}>{corrected[item.id]?.title ?? item.title}</h3>
            <p class="excerpt">{corrected[item.id]?.excerpt ?? item.excerpt}</p>
            <div class="cite">
              <Icon name="file" size={11} />
              <span class="file">{item.source}</span>
              <span>· rev {item.revision}</span>
              <span>·</span>
              <button type="button" onclick={() => app.openRun(item.runId)}>{item.runId}</button>
              <span>·</span>
              <span>{item.workspace}</span>
            </div>

            {#if expanded.has(item.id)}
              <div class="mem-evidence" transition:slide={{ duration: 160 }}>
                <h5>Evidence supplied to the model</h5>
                <ul>
                  {#each item.evidence as line (line)}<li>{line}</li>{/each}
                </ul>
              </div>
            {/if}

            {#if editing === item.id}
              <div class="correct-form">
                <textarea bind:value={draft} aria-label="Correct this memory"></textarea>
                <div class="cf-actions">
                  <button class="btn primary sm" type="button" onclick={() => saveCorrect(item.id)}
                    >Save correction</button
                  >
                  <button class="btn ghost sm" type="button" onclick={() => (editing = null)}
                    >Cancel</button
                  >
                </div>
              </div>
            {/if}

            <div class="mem-actions">
              <span class="used">Used in {item.used} run{item.used === 1 ? '' : 's'}</span>
              <button class="btn ghost sm" type="button" onclick={() => toggleExpand(item.id)}>
                {expanded.has(item.id) ? 'Hide evidence' : 'Expand evidence'}
              </button>
              <button class="btn ghost sm" type="button" onclick={() => startCorrect(item.id)}
                >Correct</button
              >
              <button class="btn ghost sm" type="button" onclick={() => forget(item.id)}>
                {confirmId === item.id ? 'Confirm delete' : 'Forget'}
              </button>
            </div>
          </article>
        {/if}
      {/each}
    </div>

    <div class="stack">
      <div class="side-card">
        <h4>Index</h4>
        <div class="kv"><span class="k">Lexical baseline</span><span class="v">Ready</span></div>
        <div class="kv">
          <span class="k">Embedding index</span><span class="v">Generation 4</span>
        </div>
        <div class="kv"><span class="k">Vectors</span><span class="v">1,284 · 768d</span></div>
        <div class="kv"><span class="k">Reranker</span><span class="v">Local · idle</span></div>
        <div class="meter" style="margin-top:12px">
          <i style="width:{rebuilding ? 46 : 100}%"></i>
        </div>
        <div class="set-note">
          {rebuilding
            ? 'Rebuilding… validated vectors replace generation 4 atomically.'
            : 'Healthy · last validated 12m ago.'}
        </div>
        <button
          class="btn secondary sm"
          type="button"
          style="width:100%;margin-top:10px"
          onclick={rebuild}
          disabled={rebuilding}
        >
          {rebuilding ? 'Rebuilding…' : 'Rebuild index'}
        </button>
      </div>

      <div class="side-card">
        <h4>Retention</h4>
        <div class="field" style="margin:0 0 10px">
          <label for="retention">Raw artifacts</label>
          <select id="retention" class="select" bind:value={retention} style="height:32px">
            <option value="30">30 days</option>
            <option value="90">90 days</option>
            <option value="365">1 year</option>
            <option value="forever">Keep until deleted</option>
          </select>
        </div>
        <div class="set-note">
          Summaries keep citations. Large artifacts follow this window; backup expiry is disclosed
          separately.
        </div>
        <div class="set-link-row" style="margin-top:10px">
          <Icon name="download" size={13} />
          <span>Export all memory</span>
          <span class="spacer"></span>
          <button class="btn link" type="button" style="font-size:11px" onclick={exportMemory}
            >Export</button
          >
        </div>
        <div class="set-link-row">
          <Icon name="trash" size={13} />
          <span>Forgotten items</span>
          <span class="spacer"></span>
          <span class="mono" style="font-size:11px">{removed.size}</span>
        </div>
      </div>

      <div class="side-card">
        <h4>Scope</h4>
        <div class="kv"><span class="k">Default</span><span class="v">Workspace</span></div>
        <div class="kv">
          <span class="k">Cross-workspace</span><span class="v"
            >{granted ? 'Granted' : 'No grant'}</span
          >
        </div>
        <div class="kv"><span class="k">Queries logged</span><span class="v">Local only</span></div>
        <div class="set-note">
          Retrieval checks scope before every route. A revoked grant cannot be replayed from cache.
        </div>
      </div>
    </div>
  </div>
</div>

<style>
  .callout {
    align-items: flex-start;
  }
</style>
