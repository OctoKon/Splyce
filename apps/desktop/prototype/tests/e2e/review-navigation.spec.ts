import { browser, $, expect } from '@wdio/globals';
import { describe, it } from 'mocha';
import { setHash } from './nav';

describe('review navigation recovery', () => {
  it('preserves focus when the desktop sidebar is folded and unfolded', async () => {
    await browser.setWindowSize(1280, 800);
    await setHash('#/work');
    const reopen = await $('button[aria-label="Open sidebar"]');
    if (await reopen.isDisplayed()) await reopen.click();
    await $('button[aria-label="Collapse sidebar"]').click();
    await expect(reopen).toBeFocused();
    await browser.keys('Enter');
    await expect($('button[aria-label="Collapse sidebar"]')).toBeFocused();
  });

  it('contains review focus, displays actual totals and restores the opener', async () => {
    await setHash('#/work');
    await $('.work-page textarea').setValue('Review navigation regression');
    await browser.keys('Enter');
    await $('.run').waitForDisplayed();
    await $('button[aria-label="Review changes and receipts"]').click();
    const file = await $('.diff-file');
    await file.waitForDisplayed();
    await file.click();
    const dialog = await $('dialog[aria-label="Review changes"]');
    await expect(dialog).toBeDisplayed();
    await expect($('.diff-modal-head span')).toHaveText('1 file · +18 −6');
    await expect($('button[aria-label="Close review"]')).toBeFocused();
    for (let index = 0; index < 12; index++) {
      await browser.keys('Tab');
      expect(
        await browser.execute(() =>
          document.querySelector('dialog')?.contains(document.activeElement),
        ),
      ).toBe(true);
    }
    await browser.keys('Escape');
    await expect(dialog).not.toExist();
    await expect(file).toBeFocused();

    await $('.diff-review').click();
    await expect($('.diff-modal-head span')).toHaveText('3 files · +42 −11');
    await $('button[aria-label="Close review"]').click();
    await expect($('.diff-review')).toBeFocused();
  });

  it('shows an unavailable run instead of a different run', async () => {
    await setHash('#/run/no-such-run');
    await expect($('h1')).toHaveText('Run unavailable');
    await expect($('.run')).not.toExist();
    await $('button=Back to Work').click();
    await expect($('.work-line')).toBeDisplayed();
  });

  it('opens mobile navigation from a folded Run header', async () => {
    await browser.setWindowSize(1280, 800);
    await setHash('#/run/r-1042');
    await $('button[aria-label="Collapse sidebar"]').click();
    await browser.setWindowSize(800, 720);
    expect(await browser.execute(() => window.innerWidth)).toBeLessThanOrEqual(820);
    await $('.run-side-toggle').click();
    await expect($('.mb-menu')).toHaveAttribute('aria-expanded', 'true');
    await expect($('#app-sidebar .side-close')).toBeFocused();
    expect(await browser.execute(() => document.querySelector('main')?.inert)).toBe(true);
    await browser.keys('Escape');
    await expect($('.mb-menu')).toBeFocused();
  });
});
