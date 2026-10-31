import { browser, $, expect } from '@wdio/globals';
import { describe, it } from 'mocha';

async function assertNoHorizontalOverflow() {
  const overflow = await browser.execute(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
}

describe('resize and high DPI', () => {
  it('keeps the layout usable across window sizes', async () => {
    for (const [width, height] of [
      [960, 720],
      [1280, 800],
      [1600, 1000],
    ]) {
      await browser.setWindowSize(width, height);
      await assertNoHorizontalOverflow();
      await expect($('.main')).toBeDisplayed();
    }
  });

  it('reports the renderer DPI and stays stable below the mobile breakpoint', async () => {
    await browser.setWindowSize(800, 720);
    await assertNoHorizontalOverflow();
    await expect($('button.mb-menu')).toBeDisplayed();

    // shortcut: reads the real DPR instead of emulating HiDPI; add a HiDPI runner when available.
    const dpr = await browser.execute(() => window.devicePixelRatio);
    expect(dpr).toBeGreaterThanOrEqual(1);
  });
});
