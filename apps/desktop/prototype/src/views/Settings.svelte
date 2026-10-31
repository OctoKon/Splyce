<script lang="ts">
  import { onDestroy } from 'svelte';
  import { app } from '../lib/state.svelte';
  import type { Theme } from '../lib/types';
  import PageHead from '../lib/PageHead.svelte';
  import Icon from '../lib/Icon.svelte';
  import Switch from '../lib/Switch.svelte';

  type Section = 'general' | 'runtime' | 'modules' | 'memory' | 'privacy' | 'updates';

  const sections: { id: Section; label: string; index: string }[] = [
    {
      id: 'general',
      label: 'General',
      index: 'workspace name default branch theme appearance motion autosave last run shortcuts',
    },
    {
      id: 'runtime',
      label: 'Runtime',
      index: 'engine approvals concurrency timeout restart self-check pi node',
    },
    {
      id: 'modules',
      label: 'Modules',
      index: 'memory models extensions providers lsp editor plugins',
    },
    {
      id: 'memory',
      label: 'Memory & storage',
      index: 'journal retention rebuild index export data storage',
    },
    {
      id: 'privacy',
      label: 'Privacy',
      index: 'telemetry egress network delete workspace diagnostics',
    },
    {
      id: 'updates',
      label: 'Updates',
      index: 'channel automatic update version license master plan',
    },
  ];

  let active = $state<Section>('general');
  let query = $state('');

  let workspaceName = $state('payments-api');
  let defaultBranch = $state('main');
  let reduceMotion = $state(false);
  let autosave = $state(true);
  let openLast = $state(true);

  let enginePath = $state('C:\\Program Files\\Splyce\\engine');
  let concurrency = $state('2');
  let approvalMode = $state('Ask every effect');
  let timeout = $state('10');
  let restarting = $state(false);
  let checkingRuntime = $state(false);

  let journalPath = $state('%APPDATA%\\Splyce\\journal');
  let retention = $state('90');
  let rebuilding = $state(false);
  let indexState = $state('Generation 4 · validated');

  let telemetry = $state(false);
  let blockEgress = $state(true);
  let deleteArmed = $state(false);
  let deleted = $state(false);

  let channel = $state('stable');
  let autoCheck = $state(true);
  let checkingUpdate = $state(false);
  let lastCheck = $state('Never');

  let timer: ReturnType<typeof setTimeout> | undefined;

  onDestroy(() => {
    if (timer) clearTimeout(timer);
  });

  const visibleSections = $derived(
    query.trim()
      ? sections.filter((section) => {
          const needle = query.trim().toLowerCase();
          return (
            section.label.toLowerCase().includes(needle) ||
            section.index.includes(needle) ||
            (active === section.id && section.index.includes(needle))
          );
        })
      : sections,
  );

  const sectionRows = $derived(sections.find((section) => section.id === active)?.index ?? '');

  const noResults = $derived(!!query.trim() && !sectionRows.includes(query.trim().toLowerCase()));

  function show(terms: string) {
    return !query.trim() || terms.toLowerCase().includes(query.trim().toLowerCase());
  }

  function setTheme(value: string) {
    app.setTheme(value as Theme);
    app.toast(`Theme: ${value}`);
  }

  function toggleMotion(value: boolean) {
    reduceMotion = value;
    document.documentElement.dataset.motion = value ? 'reduced' : '';
    app.toast(value ? 'Motion reduced in this session' : 'Motion restored');
  }

  function restartEngine() {
    if (restarting) return;
    restarting = true;
    timer = setTimeout(() => {
      restarting = false;
      app.toast('Pi engine restarted · 0 orphaned processes');
    }, 1400);
  }

  function runSelfCheck() {
    if (checkingRuntime) return;
    checkingRuntime = true;
    timer = setTimeout(() => {
      checkingRuntime = false;
      app.toast('Self-check passed · Node 24 · WebView2 · journal writable');
    }, 1200);
  }

  function rebuildIndex() {
    if (rebuilding) return;
    rebuilding = true;
    indexState = 'Rebuilding generation 5…';
    timer = setTimeout(() => {
      rebuilding = false;
      indexState = 'Generation 5 · validated';
      app.toast('Index rebuilt and cut over atomically');
    }, 1500);
  }

  function download(name: string, payload: unknown) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportData() {
    download('splyce-workspace-export.json', {
      schemaVersion: 1,
      workspace: workspaceName,
      exportedAt: new Date().toISOString(),
      note: 'Reference export — the desktop shell exports the real journal and artifacts.',
    });
    app.toast('Workspace data exported');
  }

  async function copyDiagnostics() {
    try {
      await navigator.clipboard.writeText(
        `Splyce reference\nengine: ${enginePath}\nnode: 24.22.1\nwebview2: 128.0\njournal: ${journalPath}\nlocal only: true`,
      );
      app.toast('Diagnostics copied');
    } catch {
      app.toast('Clipboard is unavailable in this preview');
    }
  }

  function checkUpdates() {
    if (checkingUpdate) return;
    checkingUpdate = true;
    timer = setTimeout(() => {
      checkingUpdate = false;
      lastCheck = 'Just now';
      app.toast('No update · this is a local design build');
    }, 1200);
  }

  function save() {
    try {
      window.localStorage.setItem(
        'splyce.settings',
        JSON.stringify({ workspaceName, defaultBranch, retention, channel, reduceMotion }),
      );
    } catch {
      /* storage can be unavailable */
    }
    app.toast('Settings saved locally');
  }

  function deleteData() {
    if (!deleteArmed) {
      deleteArmed = true;
      return;
    }
    deleted = true;
    deleteArmed = false;
    app.toast('Deletion rehearsed · tombstone written');
  }
</script>

<div class="page">
  <PageHead
    eyebrow="Local configuration · this device"
    title="Settings"
    sub="Everything here is stored on this machine. Splyce has no telemetry service and no hosted fallback."
  >
    <div class="search">
      <span class="search-ico"><Icon name="search" size={13} /></span>
      <input bind:value={query} placeholder="Search settings…" aria-label="Search settings" />
    </div>
    <button class="btn primary" type="button" onclick={save}>Save changes</button>
  </PageHead>

  <div class="set-grid">
    <nav class="set-nav" aria-label="Settings sections">
      {#each sections as section (section.id)}
        <button
          type="button"
          class:active={active === section.id}
          onclick={() => {
            active = section.id;
            query = '';
          }}
        >
          {section.label}
        </button>
      {/each}
    </nav>

    <div>
      {#if noResults}
        <div class="set-empty">
          No settings match “{query}”.
          <button class="btn link" type="button" onclick={() => (query = '')}>Clear</button>
        </div>
      {:else}
        {#if active === 'general'}
          <div class="set-cat">Workspace</div>
          {#if show('Workspace name')}
            <div class="set-row">
              <div class="set-main">
                <div class="set-title">Workspace name</div>
                <div class="set-desc">Shown in the sidebar and on every run receipt.</div>
              </div>
              <input class="inp" bind:value={workspaceName} aria-label="Workspace name" />
            </div>
          {/if}
          {#if show('Default branch')}
            <div class="set-row">
              <div class="set-main">
                <div class="set-title">Default branch</div>
                <div class="set-desc">
                  New runs branch from this ref unless you choose another base.
                </div>
              </div>
              <select class="select" bind:value={defaultBranch} aria-label="Default branch">
                <option>main</option>
                <option>develop</option>
                <option>release/1.4</option>
              </select>
            </div>
          {/if}

          <div class="set-cat">Appearance</div>
          {#if show('Theme appearance')}
            <div class="set-row">
              <div class="set-main">
                <div class="set-title">Theme</div>
                <div class="set-desc">
                  Shared tokens; status color stays reserved for approvals and failures.
                </div>
              </div>
              <select
                class="select"
                value={app.theme}
                onchange={(event) => setTheme(event.currentTarget.value)}
                aria-label="Theme"
              >
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </div>
          {/if}
          {#if show('Reduce motion')}
            <div class="set-row">
              <div class="set-main">
                <div class="set-title">Reduce motion</div>
                <div class="set-desc">Removes page, menu and card transitions in this session.</div>
              </div>
              <Switch checked={reduceMotion} label="Reduce motion" onchange={toggleMotion} />
            </div>
          {/if}

          <div class="set-cat">Behaviour</div>
          {#if show('Autosave drafts')}
            <div class="set-row">
              <div class="set-main">
                <div class="set-title">Autosave drafts</div>
                <div class="set-desc">Keep the composer draft when you switch runs.</div>
              </div>
              <Switch
                checked={autosave}
                label="Autosave drafts"
                onchange={(value) => (autosave = value)}
              />
            </div>
          {/if}
          {#if show('Open last run on launch')}
            <div class="set-row">
              <div class="set-main">
                <div class="set-title">Open last run on launch</div>
                <div class="set-desc">Resume where you stopped instead of the work list.</div>
              </div>
              <Switch
                checked={openLast}
                label="Open last run on launch"
                onchange={(value) => (openLast = value)}
              />
            </div>
          {/if}
          {#if show('Keyboard shortcuts')}
            <div class="set-row" style="display:block">
              <div class="set-title" style="margin-bottom:8px">Keyboard shortcuts</div>
              <div class="shortcut-list">
                <div class="shortcut">
                  Command palette <span><kbd class="kbd">Ctrl</kbd><kbd class="kbd">K</kbd></span>
                </div>
                <div class="shortcut">
                  New run <span><kbd class="kbd">Ctrl</kbd><kbd class="kbd">N</kbd></span>
                </div>
                <div class="shortcut">Send message <span><kbd class="kbd">Enter</kbd></span></div>
                <div class="shortcut">
                  Switch theme <span
                    ><kbd class="kbd">Ctrl</kbd><kbd class="kbd">Shift</kbd><kbd class="kbd">L</kbd
                    ></span
                  >
                </div>
              </div>
              <p class="set-note">
                Shortcuts are handled by the desktop shell with standard focus management.
              </p>
            </div>
          {/if}
        {:else if active === 'runtime'}
          <div class="set-cat">Pi engine</div>
          {#if show('Engine path')}
            <div class="set-row">
              <div class="set-main">
                <div class="set-title">Engine path</div>
                <div class="set-desc">
                  Bundled Node 24 runtime. The renderer has no shell or filesystem access.
                </div>
              </div>
              <input class="inp" bind:value={enginePath} aria-label="Engine path" />
            </div>
          {/if}
          {#if show('Approval mode')}
            <div class="set-row">
              <div class="set-main">
                <div class="set-title">Approval mode</div>
                <div class="set-desc">
                  Policy is still checked per capability; this only changes when you are asked.
                </div>
              </div>
              <select class="select" bind:value={approvalMode} aria-label="Approval mode">
                <option>Ask every effect</option>
                <option>Auto-allow workspace reads</option>
                <option>Always ask, including reads</option>
              </select>
            </div>
          {/if}
          {#if show('Concurrent runs')}
            <div class="set-row">
              <div class="set-main">
                <div class="set-title">Concurrent runs</div>
                <div class="set-desc">
                  Bounded by measured VRAM. One writer per workspace target.
                </div>
              </div>
              <select class="select" bind:value={concurrency} aria-label="Concurrent runs">
                <option>1</option>
                <option>2</option>
                <option>3</option>
              </select>
            </div>
          {/if}
          {#if show('Shell timeout')}
            <div class="set-row">
              <div class="set-main">
                <div class="set-title">Shell timeout</div>
                <div class="set-desc">
                  Long-running processes are stopped with their process tree.
                </div>
              </div>
              <select class="select" bind:value={timeout} aria-label="Shell timeout">
                <option value="5">5 minutes</option>
                <option value="10">10 minutes</option>
                <option value="30">30 minutes</option>
              </select>
            </div>
          {/if}
          {#if show('Engine actions restart self-check')}
            <div class="set-row">
              <div class="set-main">
                <div class="set-title">Engine health</div>
                <div class="set-desc">
                  Restart the sidecar or run the installed self-check. Receipts survive both.
                </div>
              </div>
              <div class="set-actions">
                <button
                  class="btn secondary"
                  type="button"
                  onclick={runSelfCheck}
                  disabled={checkingRuntime}
                >
                  {checkingRuntime ? 'Checking…' : 'Run self-check'}
                </button>
                <button
                  class="btn ghost"
                  type="button"
                  onclick={restartEngine}
                  disabled={restarting}
                >
                  {restarting ? 'Restarting…' : 'Restart'}
                </button>
              </div>
            </div>
          {/if}

          <div class="set-cat">Runtime facts</div>
          <div class="set-link-row">
            <span>Shell</span><span class="spacer"></span><span class="muted"
              >Tauri 2 · WebView2</span
            >
          </div>
          <div class="set-link-row">
            <span>Engine</span><span class="spacer"></span><span class="muted"
              >Pi · local Node 24</span
            >
          </div>
          <div class="set-link-row">
            <span>Filesystem access</span><span class="spacer"></span><span class="muted"
              >Engine only</span
            >
          </div>
        {:else if active === 'modules'}
          <div class="set-cat">Workspace modules</div>
          <div class="set-row">
            <div class="set-main">
              <div class="set-title">Memory</div>
              <div class="set-desc">Cross-session memory, citations, retention and deletion.</div>
            </div>
            <button class="btn secondary sm" type="button" onclick={() => app.go('memory')}>
              Open
            </button>
          </div>
          <div class="set-row">
            <div class="set-main">
              <div class="set-title">Models</div>
              <div class="set-desc">Local and cloud providers, per-role bindings and credentials.</div>
            </div>
            <button class="btn secondary sm" type="button" onclick={() => app.go('models')}>
              Open
            </button>
          </div>
          <div class="set-row">
            <div class="set-main">
              <div class="set-title">Extensions</div>
              <div class="set-desc">Pinned modules, optional editor and language services.</div>
            </div>
            <button class="btn secondary sm" type="button" onclick={() => app.go('extensions')}>
              Open
            </button>
          </div>
        {:else if active === 'memory'}
          <div class="set-cat">Journal</div>
          {#if show('Journal path')}
            <div class="set-row">
              <div class="set-main">
                <div class="set-title">Journal path</div>
                <div class="set-desc">
                  Append-only local records. Intent is written before an effect; outcome after it.
                </div>
              </div>
              <input class="inp" bind:value={journalPath} aria-label="Journal path" />
            </div>
          {/if}
          {#if show('Retention raw artifacts')}
            <div class="set-row">
              <div class="set-main">
                <div class="set-title">Retention · raw artifacts</div>
                <div class="set-desc">
                  Summaries keep citations. Deleted evidence is removed from every derived index.
                </div>
              </div>
              <select class="select" bind:value={retention} aria-label="Retention">
                <option value="30">30 days</option>
                <option value="90">90 days</option>
                <option value="365">1 year</option>
                <option value="forever">Keep until deleted</option>
              </select>
            </div>
          {/if}

          <div class="set-cat">Index</div>
          <div class="set-link-row">
            <span>State</span><span class="spacer"></span><span class="muted">{indexState}</span>
          </div>
          {#if show('Rebuild memory index')}
            <div class="set-row">
              <div class="set-main">
                <div class="set-title">Rebuild memory index</div>
                <div class="set-desc">
                  Validates the new generation before an atomic cutover. Old vectors never mix with
                  new ones.
                </div>
              </div>
              <button
                class="btn secondary"
                type="button"
                onclick={rebuildIndex}
                disabled={rebuilding}
              >
                {rebuilding ? 'Rebuilding…' : 'Rebuild now'}
              </button>
            </div>
          {/if}
          {#if show('Export all data')}
            <div class="set-row">
              <div class="set-main">
                <div class="set-title">Export workspace data</div>
                <div class="set-desc">
                  Runs, receipts, summaries and citations as a single local archive.
                </div>
              </div>
              <button class="btn secondary" type="button" onclick={exportData}>
                <Icon name="download" size={12} /> Export
              </button>
            </div>
          {/if}
        {:else if active === 'privacy'}
          <div class="set-cat">Local only</div>
          {#if show('Telemetry')}
            <div class="set-row">
              <div class="set-main">
                <div class="set-title">Telemetry</div>
                <div class="set-desc">
                  No telemetry service exists in Splyce. This switch is intentionally fixed off.
                </div>
              </div>
              <div class="set-actions">
                <span class="locked"><Icon name="lock" size={10} /> Off</span>
                <Switch checked={telemetry} disabled label="Telemetry (fixed off)" />
              </div>
            </div>
          {/if}
          {#if show('External egress')}
            <div class="set-row">
              <div class="set-main">
                <div class="set-title">Block external egress</div>
                <div class="set-desc">
                  Applies to model roles and MCP servers. Localhost stays available; remote calls
                  stay denied.
                </div>
              </div>
              <Switch
                checked={blockEgress}
                label="Block external egress"
                onchange={(value) => {
                  blockEgress = value;
                  app.toast(
                    value
                      ? 'External egress blocked'
                      : 'Egress policy relaxed · remote tools still need a grant',
                  );
                }}
              />
            </div>
          {/if}
          {#if show('Diagnostics clipboard')}
            <div class="set-row">
              <div class="set-main">
                <div class="set-title">Diagnostics</div>
                <div class="set-desc">
                  A local summary of versions and paths. Credentials are never included.
                </div>
              </div>
              <button class="btn secondary" type="button" onclick={copyDiagnostics}>
                <Icon name="copy" size={12} /> Copy
              </button>
            </div>
          {/if}

          <div class="set-cat">Deletion</div>
          {#if deleted}
            <div class="banner" style="margin-top:10px">
              <Icon name="check" size={13} stroke={2.2} />
              <div class="banner-main">
                <b>Workspace data deleted.</b> Tombstone written; indexes queued for rebuild. Backup expiry
                is disclosed separately.
              </div>
              <button
                class="btn sm ghost"
                type="button"
                onclick={() => {
                  deleted = false;
                  app.toast('Reference state restored');
                }}>Reset</button
              >
            </div>
          {:else if show('Delete workspace data')}
            <div class="danger-zone">
              <div class="dz-title">Delete workspace data</div>
              <div class="dz-body">
                Removes raw artifacts, summaries, vectors, caches and exports for this workspace.
                This cannot be undone.
                <span class="muted"> Reference build rehearses the flow.</span>
              </div>
              <div class="dz-actions">
                <button
                  class="btn"
                  class:danger={deleteArmed}
                  class:outline-danger={!deleteArmed}
                  type="button"
                  onclick={deleteData}
                >
                  {deleteArmed ? 'Confirm delete workspace' : 'Delete workspace data'}
                </button>
                {#if deleteArmed}
                  <button class="btn ghost" type="button" onclick={() => (deleteArmed = false)}
                    >Cancel</button
                  >
                {/if}
              </div>
            </div>
          {/if}
        {:else}
          <div class="set-cat">Release channel</div>
          {#if show('Update channel')}
            <div class="set-row">
              <div class="set-main">
                <div class="set-title">Update channel</div>
                <div class="set-desc">
                  Exact dependency patches are frozen in the validated desktop lockfile.
                </div>
              </div>
              <select class="select" bind:value={channel} aria-label="Update channel">
                <option value="stable">Stable</option>
                <option value="beta">Beta</option>
              </select>
            </div>
          {/if}
          {#if show('Check automatically')}
            <div class="set-row">
              <div class="set-main">
                <div class="set-title">Check automatically</div>
                <div class="set-desc">
                  One local check per launch. Never a background telemetry ping.
                </div>
              </div>
              <Switch
                checked={autoCheck}
                label="Check for updates automatically"
                onchange={(value) => (autoCheck = value)}
              />
            </div>
          {/if}
          {#if show('Updates last check')}
            <div class="set-row">
              <div class="set-main">
                <div class="set-title">Updates</div>
                <div class="set-desc">
                  Last check: {lastCheck}. Signed artifacts and SBOMs ship with the release.
                </div>
              </div>
              <button
                class="btn secondary"
                type="button"
                onclick={checkUpdates}
                disabled={checkingUpdate}
              >
                {checkingUpdate ? 'Checking…' : 'Check for updates'}
              </button>
            </div>
          {/if}

          <div class="set-cat">About</div>
          <div class="set-link-row">
            <span>Version</span><span class="spacer"></span><span class="muted"
              >0.1.0 · reference</span
            >
          </div>
          <div class="set-link-row">
            <span>License</span><span class="spacer"></span><a
              class="btn link"
              style="font-size:12px"
              href="https://github.com/OctoKon/Splyce/blob/main/LICENSE"
              target="_blank"
              rel="noreferrer">AGPL-3.0-only</a
            >
          </div>
          <div class="set-link-row">
            <span>Implementation plan</span>
            <span class="spacer"></span>
            <a
              class="btn link"
              style="font-size:12px"
              href="https://github.com/OctoKon/Splyce/blob/main/MASTER-PLAN.md"
              target="_blank"
              rel="noreferrer">Master plan ↗</a
            >
          </div>
          <div class="set-link-row">
            <span>Runtime status</span><span class="spacer"></span><span class="muted"
              >n=0 · not built</span
            >
          </div>
        {/if}
      {/if}
    </div>
  </div>
</div>

<style>
  .kbd {
    font-family: var(--font);
  }
  .select,
  .inp {
    min-width: 150px;
  }
</style>
