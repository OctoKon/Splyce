import { $, browser } from '@wdio/globals';

export async function openNav() {
  const menu = await $('button.mb-menu');
  if (await menu.isDisplayed()) {
    if ((await menu.getAttribute('aria-expanded')) !== 'true') await menu.click();
    return;
  }

  const open = await $('button[aria-label="Open sidebar"]');
  if (await open.isDisplayed()) await open.click();
}

export async function goto(page: 'Work' | 'Runs' | 'Settings') {
  await openNav();
  await $(`.nav-item*=${page}`).click();
}

export async function setHash(path: string) {
  await browser.execute((next) => (window.location.hash = next), path);
}
