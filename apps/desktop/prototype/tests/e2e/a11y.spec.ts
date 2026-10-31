import AxeBuilder from '@axe-core/webdriverio';
import { $, browser } from '@wdio/globals';
import { describe, it } from 'mocha';
import { setHash } from './nav';

const pages = [
  { label: 'Work', hash: '#/work' },
  { label: 'Runs', hash: '#/runs' },
  { label: 'Settings', hash: '#/settings' },
];

describe('accessibility', () => {
  for (const page of pages) {
    it(`has no serious or critical violations on ${page.label}`, async () => {
      await setHash(page.hash);
      await $(page.label === 'Work' ? '.work-line' : 'h1').waitForDisplayed();

      const results = await new AxeBuilder({ client: browser })
        .setLegacyMode(true)
        .withTags(['wcag2a', 'wcag2aa'])
        .analyze();
      const blocking = results.violations.filter(
        (violation) => violation.impact === 'serious' || violation.impact === 'critical',
      );

      if (blocking.length) {
        throw new Error(
          blocking
            .map(
              (violation) =>
                `${violation.id}: ${violation.help}\n${violation.nodes
                  .map((node) => `  ${node.target.join(' ')} — ${node.failureSummary}`)
                  .join('\n')}`,
            )
            .join('\n'),
        );
      }
    });
  }
});
