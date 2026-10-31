<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';
  import { fade } from 'svelte/transition';
  import { app } from '../lib/state.svelte';
  import { diffFiles, receipts as seedReceipts } from '../lib/data';
  import Icon from '../lib/Icon.svelte';
  import Chip from '../lib/Chip.svelte';
  import StatusChip from '../lib/StatusChip.svelte';
  import Composer from '../lib/Composer.svelte';
  import Picker from '../lib/Picker.svelte';
  import ApprovalCard from '../lib/ApprovalCard.svelte';
  import DiffView from '../lib/DiffView.svelte';
  import { clickOutside } from '../lib/actions';

  type Tab = 'changes' | 'context' | 'receipts';
  type Extra = { id: number; role: 'user' | 'agent'; text: string };

  let {
    sidebarCollapsed = false,
    ontoggleSidebar,
  }: { sidebarCollapsed?: boolean; ontoggleSidebar?: () => void } = $props();

  const run = $derived(app.currentRun);
  let tab = $state<Tab>('changes');
  let menuOpen = $state(false);
  let evidenceOpen = $state(false);
  let isDesktop = $state(window.matchMedia('(min-width: 821px)').matches);
  let inspectorOpen = $state(false);
  let closeInspector = $state<HTMLButtonElement>();
  let evidenceBtn = $state<HTMLButtonElement>();
  let message = $state('');
  let mode = $state('Build');
  let effort = $state('Max');
  let extra = $state<Extra[]>([]);
  let queued = $state(false);
  let streamEl = $state<HTMLElement>();
  let atBottom = $state(true);
  let comments = $state<Record<string, string>>({});
  let diffOpen = $state(false);
  let diffFile = $state<string | null>(null);
  let nextTurn = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const receipts = seedReceipts;
  const commentCount = $derived(Object.keys(comments).length);
  const visibleDiff = $derived(
    diffFile ? diffFiles.filter((file) => file.path === diffFile) : diffFiles,
  );

  function openDiff(path: string | null = null) {
    diffFile = path;
    diffOpen = true;
  }

  function closeDiff() {
    diffOpen = false;
    diffFile = null;
  }

  onDestroy(() => {
    if (timer) clearTimeout(timer);
  });

  onMount(() => {
    // Open a run that needs a decision at the decision, not at the top of the task.
    if (run.status !== 'approval' || run.approval) return;
    const stream = document.querySelector<HTMLElement>('.stream');
    if (stream) stream.scrollTop = stream.scrollHeight;
  });

  onMount(() => {
    const media = window.matchMedia('(min-width: 821px)');
    const update = () => (isDesktop = media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  });

  $effect(() => {
    if (evidenceOpen) closeInspector?.focus();
  });

  function closeEvidence() {
    evidenceOpen = false;
    inspectorOpen = false;
    requestAnimationFrame(() => evidenceBtn?.focus());
  }

  function toggleEvidence() {
    if (isDesktop) inspectorOpen = !inspectorOpen;
    else evidenceOpen = true;
  }

  function resolve(decision: 'allowed' | 'always' | 'denied') {
    app.resolveApproval(run.id, decision);
    app.toast(decision === 'denied' ? 'Denied · no bytes changed' : 'Approved · effect recorded');
  }

  async function copy(text: string, note = 'Copied to clipboard') {
    try {
      await navigator.clipboard.writeText(text);
      app.toast(note);
    } catch {
      app.toast('Clipboard is unavailable in this preview');
    }
  }

  function exportReceipts() {
    const payload = {
      schemaVersion: 1,
      runId: run.id,
      finalRevision: run.base,
      verification: run.verification ?? null,
      receipts,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${run.id}-receipts.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    app.toast('Receipts exported');
  }

  function addComment(key: string, _path: string, _line: number, text: string) {
    comments = { ...comments, [key]: text };
    app.toast('Comment saved to the review');
  }

  function requestChanges() {
    extra = [
      ...extra,
      {
        id: ++nextTurn,
        role: 'user',
        text: `Please revise before apply${commentCount ? ` (${commentCount} line comment${commentCount > 1 ? 's' : ''})` : ''}. Keep the fix bound to this base.`,
      },
    ];
    app.toast('Change request added to the run');
  }

  function onStreamScroll() {
    if (!streamEl) return;
    const distance = streamEl.scrollHeight - streamEl.scrollTop - streamEl.clientHeight;
    atBottom = distance < 48;
  }

  function scrollToBottom(smooth = true) {
    streamEl?.scrollTo({
      top: streamEl.scrollHeight,
      behavior: smooth ? 'smooth' : 'auto',
    });
  }

  async function send(text: string) {
    extra = [...extra, { id: ++nextTurn, role: 'user', text }];
    message = '';
    await tick();
    scrollToBottom();
    if (run.status === 'running') {
      queued = true;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        extra = [
          ...extra,
          {
            id: ++nextTurn,
            role: 'agent',
            text: 'Noted. I will keep the change inside the current grant and add the new case to the same verification command. No new effect runs without an approval.',
          },
        ];
        queued = false;
        void tick().then(() => scrollToBottom());
        app.toast('Agent replied · local runtime');
      }, 1100);
    } else {
      app.toast('Message recorded · the agent is not running');
    }
  }

  function stopRun() {
    menuOpen = false;
    app.updateRun(run.id, {
      status: 'stopped',
      stopReason: 'Stopped by you. No unresolved effects; the working tree was left unchanged.',
    });
    app.toast('Run stopped · cleanup recorded');
  }

  function duplicate() {
    menuOpen = false;
    app.createRun(run.prompt, run.workspace, run.base, run.model);
    app.toast('Run duplicated on the same base');
  }

  function rerun() {
    app.createRun(run.prompt, run.workspace, 'main@a3f91c2', run.model);
    app.toast('New run started on the current base');
  }
</script>

<svelte:window
  onkeydown={(event) => {
    if (event.key === 'Escape') {
      if (diffOpen) closeDiff();
      else if (evidenceOpen) closeEvidence();
      menuOpen = false;
    }
  }}
/>

<div class="run">
  <div class="run-top">
    {#if sidebarCollapsed}
      <button
        class="icon-btn run-side-toggle"
        type="button"
        aria-label="Open sidebar"
        title="Open sidebar"
        onclick={ontoggleSidebar}
      >
        <Icon name="panel-left" size={15} />
      </button>
    {/if}
    <div class="run-head">
      <h2>{run.title}</h2>
      <span class="run-meta">{run.workspace} · {run.branch} · {run.base}</span>
    </div>
    <div class="run-status">
      {#if run.status === 'approval' && run.approval}
        <Chip tone="outline" dot>{run.approval === 'denied' ? 'Denied' : 'Approved'}</Chip>
      {:else}
        <StatusChip status={run.status} />
      {/if}
    </div>
    <span class="spacer"></span>
    <button
      class="btn secondary sm review-btn"
      type="button"
      title="Review changes and receipts"
      aria-label="Review changes and receipts"
      aria-expanded={isDesktop ? inspectorOpen : evidenceOpen}
      bind:this={evidenceBtn}
      onclick={toggleEvidence}
    >
      Review
    </button>
    <div class="more-wrap" use:clickOutside={() => (menuOpen = false)}>
      <button
        class="icon-btn"
        type="button"
        aria-label="More run actions"
        aria-expanded={menuOpen}
        onclick={() => (menuOpen = !menuOpen)}
      >
        <Icon name="more" size={16} />
      </button>
      {#if menuOpen}
        <div class="menu more-menu" transition:fade={{ duration: 100 }}>
          <button type="button" onclick={duplicate}>Duplicate run</button>
          <button
            type="button"
            onclick={() => {
              menuOpen = false;
              copy(`splyce://run/${run.id}`, 'Run link copied');
            }}>Copy run link</button
          >
          <button
            type="button"
            onclick={() => {
              menuOpen = false;
              exportReceipts();
            }}>Export receipts</button
          >
          <button
            type="button"
            onclick={() => {
              menuOpen = false;
              copy(`splyce://run/${run.id}/diff`, 'Diff link copied');
            }}>Copy diff link</button
          >
          <button
            type="button"
            onclick={stopRun}
            disabled={run.status !== 'running' && run.status !== 'approval'}
          >
            Stop run
          </button>
        </div>
      {/if}
    </div>
  </div>

  <div class="run-body">
    <div class="run-main" inert={evidenceOpen && !isDesktop}>
      <div class="stream" bind:this={streamEl} onscroll={onStreamScroll}>
        <div class="stream-inner">
          <div class="turn">
            <span class="avatar">You</span>
            <div>
              <div class="who"><b>You</b><span>task · {run.id}</span></div>
              <div class="body"><p>{run.prompt}</p></div>
            </div>
          </div>

          <div class="turn agent">
            <span class="avatar">Pi</span>
            <div>
              <div class="who"><b>Pi</b><span>local · {run.model}</span></div>
              <div class="body">
                {#if run.status === 'approval'}
                  <p>
                    I found the failure in <code>src/webhooks/verify.ts</code>: a missing timestamp
                    header fell through the normaliser and failed after the HMAC comparison. The
                    patch adds an explicit rejection and a regression case.
                    <strong>Verification passed on the final revision.</strong>
                  </p>
                  <div class="plan">
                    <div class="plan-row">
                      <span class="n">01</span>
                      <div>
                        <b>Reproduce</b>Read the handler, header helper and the failing test.
                      </div>
                    </div>
                    <div class="plan-row">
                      <span class="n">02</span>
                      <div>
                        <b>Patch once</b>Reject missing and stale timestamps before comparison.
                      </div>
                    </div>
                    <div class="plan-row">
                      <span class="n">03</span>
                      <div>
                        <b>Verify</b><code>npm test -- webhooks</code> · 24 passed on the final tree.
                      </div>
                    </div>
                  </div>
                {:else if run.status === 'running'}
                  <p>
                    I am working inside <code>{run.branch}</code> against base
                    <code>{run.base}</code>. The first read is complete; edits stay behind the
                    policy gate.
                  </p>
                  <div class="plan">
                    <div class="plan-row">
                      <span class="n">01</span>
                      <div>
                        <b>Inspect</b>Read the invoice query path and existing contract tests.
                      </div>
                    </div>
                    <div class="plan-row">
                      <span class="n">02</span>
                      <div><b>Implement</b>Keyset cursor with the existing response envelope.</div>
                    </div>
                    <div class="plan-row">
                      <span class="n">03</span>
                      <div>
                        <b>Verify</b>Run pagination tests, bind the receipt to the final revision.
                      </div>
                    </div>
                  </div>
                {:else if run.status === 'verified'}
                  <p>
                    The task is complete on the final revision. The verifier command exited 0 and
                    the receipt is bound to <code>{run.base}</code>. Review the diff and apply
                    separately.
                  </p>
                {:else}
                  <p>I stopped before applying. Nothing was written outside the owned worktree.</p>
                {/if}
              </div>
            </div>
          </div>

          {#if run.status === 'stopped'}
            <div class="banner err">
              <Icon name="alert" size={14} />
              <div class="banner-main">
                <b>Stopped before apply.</b>
                {run.stopReason}
              </div>
              <button class="btn sm secondary" type="button" onclick={rerun}
                >Re-run on current base</button
              >
            </div>
          {:else if run.status === 'verified'}
            <div class="banner">
              <Icon name="check" size={14} stroke={2.2} />
              <div class="banner-main">
                <b>Verified complete.</b>
                {run.verification?.command ?? 'npm test'} · exit {run.verification?.exit ?? 0} ·
                {run.verification?.tests ?? 0} tests · bound to {run.base}
              </div>
              <button class="btn sm secondary" type="button" onclick={() => (tab = 'changes')}
                >Review diff</button
              >
            </div>
          {/if}

          {#if run.status === 'approval'}
            <ApprovalCard {run} onresolve={resolve} />
          {/if}

          {#if run.status === 'running'}
            <div class="queued" style="margin-left:42px;margin-bottom:24px">
              <Chip dot live>Working</Chip>
              Reading invoice pagination · 2 tools active · nothing applied yet
            </div>
          {/if}

          {#each extra as turn (turn.id)}
            <div class="turn" class:agent={turn.role === 'agent'}>
              <span class="avatar">{turn.role === 'user' ? 'You' : 'Pi'}</span>
              <div>
                <div class="who">
                  <b>{turn.role === 'user' ? 'You' : 'Pi'}</b>
                  <span>{turn.role === 'user' ? 'steering' : 'local response'}</span>
                </div>
                <div class="body"><p>{turn.text}</p></div>
              </div>
            </div>
          {/each}

          {#if queued}
            <div class="turn agent">
              <span class="avatar">Pi</span>
              <div>
                <div class="who"><b>Pi</b><span>thinking locally</span></div>
                <div class="working">
                  <Chip dot live>Working</Chip> Checking the next tool against the grant…
                </div>
              </div>
            </div>
          {/if}
        </div>
      </div>

      {#if !atBottom}
        <button
          class="scroll-bottom"
          type="button"
          aria-label="Scroll to latest"
          title="Scroll to latest"
          onclick={() => scrollToBottom()}
        >
          <Icon name="chevron-down" size={16} />
        </button>
      {/if}

      <div class="composer-wrap">
        <Composer
          bind:value={message}
          compact
          allowAttachments
          placeholder="Ask anything, / for commands, @ for context…"
          onsend={send}
        >
          <Picker
            trigger={mode}
            value={mode}
            options={[
              { value: 'Build', label: 'Build' },
              { value: 'Plan', label: 'Plan' },
              { value: 'Review', label: 'Review' },
            ]}
            onchange={(value) => (mode = value)}
          />
          <Picker
            trigger={run.model}
            value={run.model}
            placement="up"
            options={[
              { value: 'Qwen3-Coder-30B-A3B', label: 'Pi · Qwen3-Coder' },
              { value: 'Devstral-Small-24B', label: 'Pi · Devstral' },
            ]}
            onchange={(value) => app.updateRun(run.id, { model: value })}
          />
          <Picker
            trigger={effort}
            value={effort}
            placement="up"
            options={[
              { value: 'Low', label: 'Low' },
              { value: 'Medium', label: 'Medium' },
              { value: 'Max', label: 'Max' },
            ]}
            onchange={(value) => (effort = value)}
          />
        </Composer>
      </div>
    </div>

    {#if evidenceOpen && !isDesktop}
      <button
        class="evidence-scrim"
        type="button"
        aria-label="Close run evidence"
        onclick={closeEvidence}
      ></button>
    {/if}

    <aside
      class="inspector"
      class:open={evidenceOpen}
      class:desktop-closed={!inspectorOpen}
      aria-label="Run evidence"
    >
      <button
        class="insp-close icon-btn"
        type="button"
        aria-label="Close run evidence"
        bind:this={closeInspector}
        onclick={closeEvidence}
      >
        <Icon name="x" size={15} />
      </button>
      <div class="insp-tabs" role="tablist" aria-label="Run inspector">
        <button
          class="insp-tab"
          class:active={tab === 'changes'}
          role="tab"
          aria-selected={tab === 'changes'}
          onclick={() => (tab = 'changes')}
        >
          Changes {#if tab === 'changes'}<span class="ink"></span>{/if}
        </button>
        <button
          class="insp-tab"
          class:active={tab === 'context'}
          role="tab"
          aria-selected={tab === 'context'}
          onclick={() => (tab = 'context')}
        >
          Context {#if tab === 'context'}<span class="ink"></span>{/if}
        </button>
        <button
          class="insp-tab"
          class:active={tab === 'receipts'}
          role="tab"
          aria-selected={tab === 'receipts'}
          onclick={() => (tab = 'receipts')}
        >
          Receipts {#if tab === 'receipts'}<span class="ink"></span>{/if}
        </button>
      </div>

      <div class="insp-pane">
        {#if tab === 'changes'}
          {#if run.status === 'running'}
            <div class="empty" style="padding:28px 0">
              No final diff yet.<br />Changes appear after the first verified edit.
            </div>
          {:else}
            <div class="insp-h">
              <span>{diffFiles.length} files · +42 −11</span>
              <span class="spacer"></span>
              <span>{commentCount} comments</span>
            </div>
            <div class="diff-files">
              {#each diffFiles as file (file.path)}
                <button class="diff-file" type="button" onclick={() => openDiff(file.path)}>
                  <Icon name="file" size={13} />
                  <span class="df-name">{file.path}</span>
                  <span class="df-add">+{file.additions}</span>
                  <span class="df-del">−{file.deletions}</span>
                </button>
              {/each}
            </div>
            <button class="btn secondary sm diff-review" type="button" onclick={() => openDiff()}>
              Review all changes
            </button>
            <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
              <button
                class="btn secondary sm"
                type="button"
                onclick={() => copy(`git diff ${run.base}`, 'Diff command copied')}
              >
                Copy diff range
              </button>
              <button class="btn ghost sm" type="button" onclick={requestChanges}
                >Request changes</button
              >
            </div>
          {/if}
        {:else if tab === 'context'}
          <div class="side-card" style="border:0;padding:0;background:transparent">
            <div class="insp-h">Run</div>
            <div class="kv">
              <span class="k">Workspace</span><span class="v">{run.workspace}</span>
            </div>
            <div class="kv">
              <span class="k">Branch</span><span class="v" style="font-size:11px">{run.branch}</span
              >
            </div>
            <div class="kv"><span class="k">Base</span><span class="v mono">{run.base}</span></div>
            <div class="kv"><span class="k">Engine</span><span class="v">Pi · local</span></div>
            <div class="kv"><span class="k">Model</span><span class="v">{run.model}</span></div>
            <div class="kv">
              <span class="k">Policy</span><span class="v">workspace write</span>
            </div>
          </div>

          <div class="insp-section" style="margin-top:18px">
            <div class="insp-h">
              Context budget <span class="spacer"></span><span class="mono">38%</span>
            </div>
            <div class="meter thin"><i style="width:38%"></i></div>
            <div class="hw-use"><b>24,180</b> of 64,000 tokens · lexical baseline</div>
          </div>

          <div class="insp-section">
            <div class="insp-h">Sources</div>
            <div class="src-row">
              <span class="s-kind">LSP</span>
              <div class="s-main">
                <div class="s-name">typescript · payments-api</div>
                <div class="s-meta">revision a3f91c2 · healthy</div>
              </div>
            </div>
            <div class="src-row">
              <span class="s-kind">LEX</span>
              <div class="s-main">
                <div class="s-name">rg webhook signature</div>
                <div class="s-meta">4 files · revision a3f91c2</div>
              </div>
            </div>
            <div class="src-row">
              <span class="s-kind">MEM</span>
              <div class="s-main">
                <div class="s-name">m-201 · missing timestamp decision</div>
                <div class="s-meta">cited · capsule s-38</div>
              </div>
            </div>
          </div>

          <div class="insp-section">
            <div class="insp-h">Terminal</div>
            <div class="term">
              $ npm test -- webhooks
              <span class="dim">PASS</span> src/webhooks/verify.test.ts
              <span class="ok">Tests 24 passed (24)</span>
              <span class="dim">Time 1.81s · exit 0</span>
            </div>
          </div>

          <button
            class="btn secondary sm"
            type="button"
            style="width:100%"
            onclick={() =>
              copy(
                JSON.stringify({ run: run.id, base: run.base }, null, 2),
                'Context bundle copied',
              )}
          >
            Copy context bundle
          </button>
        {:else}
          {#if run.verification}
            <div class="verify-box">
              <div class="vb-top">
                <Icon name="receipt" size={12} /> Final-revision receipt
                <span class="ok">exit {run.verification.exit}</span>
              </div>
              <div class="vb-cmd mono">{run.verification.command}</div>
              <div class="vb-meta">
                {run.verification.tests} passed · {run.verification.duration} · {run.verification
                  .at} · {run.base}
              </div>
            </div>
          {:else}
            <div class="banner" style="margin-bottom:14px">
              <Icon name="clock" size={13} />
              <div class="banner-main">
                No verification receipt yet. It is created only after the final tree passes.
              </div>
            </div>
          {/if}

          <div class="insp-h">
            Chain <span class="spacer"></span><span class="mono">{receipts.length} events</span>
          </div>
          {#each receipts as receipt (receipt.id)}
            <div class="receipt" class:fail={receipt.state === 'failed'}>
              <div class="receipt-top">
                <Icon
                  name={receipt.kind === 'verification'
                    ? 'check'
                    : receipt.kind === 'intent'
                      ? 'shield'
                      : 'terminal'}
                  size={11}
                />
                <span class="r-id">{receipt.id}</span>
                <span class="r-time">{receipt.at}</span>
              </div>
              <div class="receipt-label">{receipt.label}</div>
              <div class="receipt-detail">{receipt.detail}</div>
              <button
                class="btn link copy-line"
                type="button"
                style="font-size:10px"
                onclick={() => copy(receipt.id, 'Receipt ID copied')}
              >
                Copy ID
              </button>
            </div>
          {/each}

          <button
            class="btn secondary sm"
            type="button"
            style="width:100%;margin-top:14px"
            onclick={exportReceipts}
          >
            <Icon name="download" size={12} /> Export receipt chain
          </button>
        {/if}
      </div>

      <div class="insp-foot">
        <span class="ok"><Icon name="shield" size={12} /></span>
        Chain intact · {receipts.length} receipts
        <span class="spacer"></span>
        <span>journal · local</span>
      </div>
    </aside>
  </div>

  {#if diffOpen}
    <div
      class="diff-overlay"
      role="presentation"
      onclick={(event) => {
        if (event.target === event.currentTarget) closeDiff();
      }}
    >
      <div class="diff-modal" role="dialog" aria-modal="true" aria-label="Review changes">
        <header class="diff-modal-head">
          <div>
            <h3>{diffFile ?? 'All changes'}</h3>
            <span>{visibleDiff.length} file{visibleDiff.length === 1 ? '' : 's'} · +42 −11</span>
          </div>
          <button class="icon-btn" type="button" aria-label="Close review" onclick={closeDiff}>
            <Icon name="x" size={15} />
          </button>
        </header>
        <div class="diff-modal-body">
          <DiffView files={visibleDiff} {comments} oncomment={addComment} />
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .more-wrap {
    position: relative;
  }
  .more-menu {
    top: calc(100% + 6px);
    right: 0;
    left: auto;
    min-width: 176px;
  }
  .more-menu button:disabled {
    opacity: 0.4;
    pointer-events: none;
  }
  .diff-files {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .diff-file {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    background: var(--neutral);
    color: var(--on-surface);
    text-align: left;
    font-size: 12px;
    transition:
      background 0.15s,
      border-color 0.15s;
  }
  .diff-file:hover {
    background: var(--surface);
    border-color: var(--hover-border);
  }
  .diff-file:focus-visible {
    outline: 2px solid var(--primary);
    outline-offset: 1px;
  }
  .df-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .df-add {
    color: var(--add-text);
    font-size: 11px;
  }
  .df-del {
    color: var(--error);
    font-size: 11px;
  }
  .diff-review {
    width: 100%;
    margin-top: 10px;
  }
  .diff-overlay {
    position: fixed;
    inset: 0;
    z-index: 80;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 32px;
    background: rgba(0, 0, 0, 0.45);
    backdrop-filter: blur(4px);
    animation: overlay-in 0.18s var(--ease) both;
  }
  .diff-modal {
    display: flex;
    flex-direction: column;
    width: min(920px, 100%);
    max-height: 86vh;
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    background: var(--neutral);
    box-shadow: 0 24px 80px rgba(0, 0, 0, 0.35);
    overflow: hidden;
    animation: modal-in 0.24s var(--ease) both;
  }
  .diff-modal-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 14px 16px;
    border-bottom: 1px solid var(--border);
  }
  .diff-modal-head h3 {
    margin: 0 0 2px;
    font-size: 14px;
    font-weight: 600;
  }
  .diff-modal-head span {
    font-size: 11px;
    color: var(--text-muted);
  }
  .diff-modal-body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 16px;
  }
  @keyframes overlay-in {
    from {
      opacity: 0;
    }
  }
  @keyframes modal-in {
    from {
      opacity: 0;
      transform: translateY(12px) scale(0.98);
    }
  }
</style>
