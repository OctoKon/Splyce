import path from 'node:path';

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
        driverProvider: 'embedded',
        captureFrontendLogs: true,
        startTimeout: 60000,
      },
    ],
  ],
  framework: 'mocha',
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
