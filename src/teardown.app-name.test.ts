/**
 * The teardown's App Store line names the app the rating measures when the
 * stored reviews layer carries its name, and reads exactly as before when it
 * does not.
 */
import { describe, expect, it } from 'vitest';
import { renderTeardown } from './teardown.js';

const NOW = Date.parse('2026-10-06T00:00:00Z');
const base = { domain: 'example.com', name: 'Example Co' };

describe('teardown App Store line', () => {
  it('names the app when the reviews layer carries it', () => {
    const md = renderTeardown(
      { ...base, reviews: { appStore: { rating: 4.7, reviewCount: 21570, appName: 'Example Studio' } } },
      { nowMs: NOW },
    );
    expect(md).toContain('App Store (Example Studio): 4.7★');
  });

  it('reads as before without a name', () => {
    const md = renderTeardown(
      { ...base, reviews: { appStore: { rating: 4.7, reviewCount: 21570 } } },
      { nowMs: NOW },
    );
    expect(md).toContain('App Store: 4.7★');
    expect(md).not.toContain('App Store (');
  });
});
