import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { browser, $ } from '@wdio/globals';

const external = process.env.SPLYCE_E2E_DRIVER === 'external';

const binary = path.resolve(
  'src-tauri',
  'target',
  'debug',
  `splycefrontend${process.platform === 'win32' ? '.exe' : ''}`,
);

export const config = {
  runner: 'local',
  specs: ['./tests/e2e/**/*.spec.ts'],
  maxInstances: 1,
  maxInstancesPerCapability: 1,
  capabilities: [
    {
      maxInstances: 1,
      browserName: 'tauri',
      'tauri:options': {
        application: binary,
      },
    },
  ],
  services: [
    [
      '@wdio/tauri-service',
      {
        appBinaryPath: binary,
        driverProvider: external ? 'external' : 'embedded',
        captureFrontendLogs: !external,
        startTimeout: 60000,
      },
    ],
  ],
  framework: 'mocha',
  before: async () => {
    if (!external && browser.capabilities.browserName !== 'msedge') {
      throw new Error('Expected the embedded Tauri driver, not a standalone browser');
    }
    const handles = await browser.getWindowHandles();
    if (handles.length !== 1) throw new Error('Expected one prototype window');
    await browser.switchToWindow(handles[0]);
    await browser.execute(() => {
      location.hash = '#/work';
    });
    await browser.refresh();
    await browser.setWindowSize(1280, 800);
    await $('.work-line').waitForDisplayed();
  },
  afterTest: async (test: { title: string }, _context: unknown, result: { error?: unknown }) => {
    if (!result.error) return;
    mkdirSync('logs', { recursive: true });
    await browser.saveScreenshot(
      path.resolve('logs', `${test.title.replace(/[^a-z0-9]+/gi, '-')}.png`),
    );
    console.error(
      'Failure state:',
      await browser.execute(() => ({
        route: location.hash,
        width: innerWidth,
        focused: document.activeElement?.outerHTML.slice(0, 300),
        text: document.body.innerText.slice(-2000),
      })),
    );
  },
  reporters: ['spec'],
  mochaOpts: {
    ui: 'bdd',
    timeout: 60000,
  },
  logLevel: 'warn',
  bail: 0,
  waitforTimeout: 10000,
  connectionRetryTimeout: 120000,
  connectionRetryCount: 3,
};
