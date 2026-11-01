<script lang="ts">
  import {
    CONTRAST_PAIRS,
    TOKENS,
    TOKEN_NAMES,
    contrastRatio,
    resolveTheme,
    type ThemeName,
  } from "./tokens";

  const DARK_QUERY = "(prefers-color-scheme: dark)";
  const FORCED_QUERY = "(forced-colors: active)";

  function mediaMatches(query: string): boolean {
    return typeof window !== "undefined" &&
      typeof window.matchMedia === "function"
      ? window.matchMedia(query).matches
      : false;
  }

  let {
    theme,
    prefersDark: prefersDarkProp,
    forcedColors: forcedColorsProp,
  }: {
    theme: ThemeName;
    prefersDark?: boolean;
    forcedColors?: boolean;
  } = $props();

  let detectedPrefersDark = $state(mediaMatches(DARK_QUERY));
  let detectedForcedColors = $state(mediaMatches(FORCED_QUERY));
  const prefersDark = $derived(prefersDarkProp ?? detectedPrefersDark);
  const forcedColors = $derived(forcedColorsProp ?? detectedForcedColors);

  $effect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function" ||
      (prefersDarkProp !== undefined && forcedColorsProp !== undefined)
    ) {
      return;
    }
    const dark = window.matchMedia(DARK_QUERY);
    const forced = window.matchMedia(FORCED_QUERY);
    const onDark = (event: MediaQueryListEvent) => {
      detectedPrefersDark = event.matches;
    };
    const onForced = (event: MediaQueryListEvent) => {
      detectedForcedColors = event.matches;
    };
    detectedPrefersDark = dark.matches;
    detectedForcedColors = forced.matches;
    dark.addEventListener("change", onDark);
    forced.addEventListener("change", onForced);
    return () => {
      dark.removeEventListener("change", onDark);
      forced.removeEventListener("change", onForced);
    };
  });

  const resolved = $derived(resolveTheme(theme, { prefersDark, forcedColors }));
  const label = $derived(theme === "system" ? `system (${resolved})` : theme);
  const sheet = $derived(TOKENS[resolved]);
  const style = $derived(
    TOKEN_NAMES.map((n) => `--${n}:${sheet[n]}`).join(";"),
  );
  const checks = $derived(
    CONTRAST_PAIRS.map((p) => {
      const ratio = contrastRatio(sheet[p.fg], sheet[p.bg]);
      return { ...p, ratio, pass: ratio >= p.min };
    }),
  );
</script>

<section
  class="theme"
  {style}
  data-theme={theme}
  data-resolved-theme={resolved}
  aria-label="{label} theme specimen"
  data-testid="theme-specimen"
>
  <h3>{label}</h3>
  <ul class="tokens">
    {#each TOKEN_NAMES as name (name)}
      <li data-token={name}>
        <span class="swatch" style:background={sheet[name]} aria-hidden="true"
        ></span>
        <span>{name}</span> <code>{sheet[name]}</code>
      </li>
    {/each}
  </ul>
  <table>
    <caption>Contrast</caption>
    <thead
      ><tr><th>Pair</th><th>Ratio</th><th>Result</th></tr></thead
    >
    <tbody>
      {#each checks as c (c.fg + c.bg)}
        <tr data-pass={c.pass}>
          <td>{c.fg} on {c.bg}</td>
          <td>{c.ratio.toFixed(2)} (min {c.min})</td>
          <td>{c.pass ? "Pass" : "Fail"}</td>
        </tr>
      {/each}
    </tbody>
  </table>
  <p>
    <button type="button" class="focus-sample">Focus sample</button>
    <span class="chip danger">✕ Failed</span>
    <span class="chip pending">? Uncertain</span>
    <span class="chip positive">✓ Completed</span>
  </p>
</section>

<style>
  .theme {
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border);
    padding: 16px;
    font-size: 1rem;
  }
  .tokens {
    list-style: none;
    padding: 0;
  }
  .swatch {
    display: inline-block;
    width: 1em;
    height: 1em;
    border: 1px solid var(--border);
  }
  caption,
  code {
    color: var(--textMuted);
  }
  .focus-sample {
    background: var(--surfaceRaised);
    color: var(--text);
    border: 1px solid var(--border);
  }
  .focus-sample:focus-visible {
    outline: 3px solid var(--focus);
    outline-offset: 2px;
  }
  .danger {
    color: var(--danger);
  }
  .pending {
    color: var(--pending);
  }
  .positive {
    color: var(--positive);
  }
  @media (forced-colors: active) {
    .focus-sample:focus-visible {
      outline-color: Highlight;
    }
  }
</style>
