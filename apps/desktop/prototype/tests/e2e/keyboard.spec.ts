import { browser, $, expect } from '@wdio/globals';
import { describe, it } from 'mocha';

const theme = () => browser.execute(() => document.documentElement.dataset.theme);

describe('keyboard and focus', () => {
  it('toggles the theme from the keyboard', async () => {
    const before = await theme();
    await browser.keys(['Control', 'Shift', 'l']);
    await browser.waitUntil(async () => (await theme()) !== before, {
      timeout: 3000,
      timeoutMsg: 'theme did not change after Ctrl+Shift+L',
    });
  });

  it('closes the mobile navigation with Escape and restores focus', async () => {
    await browser.setWindowSize(800, 720);
    const menu = await $('button.mb-menu');
    await menu.waitForDisplayed();
    await menu.click();
    await expect(menu).toHaveAttribute('aria-expanded', 'true');

    await browser.keys('Escape');
    await expect(menu).toHaveAttribute('aria-expanded', 'false');

    const focused = await browser.execute(
      () => document.activeElement?.getAttribute('class') ?? '',
    );
    expect(focused).toContain('mb-menu');
  });
});
