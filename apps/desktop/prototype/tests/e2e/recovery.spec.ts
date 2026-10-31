import { browser, $, expect } from '@wdio/globals';
import { describe, it } from 'mocha';

describe('failure and recovery', () => {
  it('recovers from an unknown route and a corrupt saved theme', async () => {
    await browser.execute(() => {
      localStorage.setItem('splyce.theme', 'corrupt');
      location.hash = '#/route/that/does/not/exist';
    });
    await browser.refresh();

    await $('.work-line').waitForDisplayed({ timeout: 15000 });
    await expect($('.work-line')).toHaveText(expect.stringContaining('What are we'));
    const theme = await browser.execute(() => document.documentElement.dataset.theme);
    expect(theme).toBe('light');
  });
});
