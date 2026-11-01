import { browser, $, expect } from '@wdio/globals';
import { describe, it } from 'mocha';
import { goto } from './nav';

describe('greeting and settings search', () => {
  it('cancels a greeting draft and ignores composing keys', async () => {
    await goto('Work');
    const original = await browser.execute(() => localStorage.getItem('splyce.greeting'));
    const button = await $('button.greeting');
    const initial = await button.getText();
    await button.click();
    const input = await $('input[aria-label="Greeting"]');
    await expect(input).toBeFocused();
    await browser.keys(['Control', 'a']);
    await browser.keys('Uncommitted greeting');
    await expect(input).toHaveValue('Uncommitted greeting');
    await browser.execute(() => {
      const field = document.querySelector<HTMLInputElement>('input[aria-label="Greeting"]')!;
      for (const key of ['Enter', 'Escape']) {
        field.dispatchEvent(
          new KeyboardEvent('keydown', { key, isComposing: true, bubbles: true }),
        );
      }
    });
    await expect(input).toBeDisplayed();
    await browser.execute(() => {
      const field = document.querySelector<HTMLInputElement>('input[aria-label="Greeting"]')!;
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      field.dispatchEvent(new FocusEvent('blur'));
    });
    await expect($('button.greeting')).toHaveText(initial);
    expect(await browser.execute(() => localStorage.getItem('splyce.greeting'))).toBe(original);
    await $('button.greeting').click();
    await expect(await $('input[aria-label="Greeting"]')).toHaveValue(initial);
    await browser.keys('Escape');
  });

  it('filters module rows and reports no matches for terms spanning rows', async () => {
    await goto('Settings');
    const search = await $('input[aria-label="Search settings"]');
    await search.setValue('autosave last run');
    await expect($('.set-empty')).toBeDisplayed();
    await search.setValue('autosave');
    await expect($('.set-empty')).not.toExist();
    await expect($('.set-title=Autosave drafts')).toBeDisplayed();
    await $('button=Modules').click();
    await search.setValue('models');
    await expect($('.set-title=Models')).toBeDisplayed();
    await expect($('.set-title=Memory')).not.toExist();
    await expect($('.set-title=Extensions')).not.toExist();
    await search.setValue('not a module');
    await expect($('.set-empty')).toBeDisplayed();
  });
});
