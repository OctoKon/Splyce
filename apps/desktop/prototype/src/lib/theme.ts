import { flushSync } from 'svelte';
import { app } from './state.svelte';

let busy = false;

export function toggleThemeFrom(event: MouseEvent) {
  const root = document.documentElement;
  const reduced =
    root.dataset.motion === 'reduced' ||
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const start = (
    document as Document & {
      startViewTransition?: (callback: () => void) => {
        ready: Promise<void>;
        finished: Promise<void>;
      };
    }
  ).startViewTransition;

  if (!start || reduced || busy) {
    if (!busy) app.toggleTheme();
    return;
  }

  const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const x = event.clientX || box.left + box.width / 2;
  const y = event.clientY || box.top + box.height / 2;
  const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));

  busy = true;
  const transition = start.call(document, () => flushSync(() => app.toggleTheme()));
  transition.ready
    .then(() => {
      root.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
        {
          duration: 520,
          easing: 'cubic-bezier(0.65, 0, 0.35, 1)',
          pseudoElement: '::view-transition-new(root)',
        } as KeyframeAnimationOptions,
      );
    })
    .catch(() => {});
  transition.finished.finally(() => (busy = false));
}
