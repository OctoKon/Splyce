import { browser, $, expect } from '@wdio/globals';
import { describe, it } from 'mocha';
import { goto } from './nav';

describe('application shell', () => {
  it('launches on Work', async () => {
    await $('.work-line').waitForDisplayed({ timeout: 15000 });
    await expect($('.work-line')).toHaveText(expect.stringContaining('What are we'));
    expect(await browser.getTitle()).toContain('Splyce');
  });

  it('navigates between primary pages', async () => {
    await goto('Runs');
    await expect($('h1')).toHaveText('Runs');

    await goto('Settings');
    await expect($('h1')).toHaveText('Settings');

    await goto('Work');
    await expect($('.work-line')).toHaveText(expect.stringContaining('What are we'));
  });
});
