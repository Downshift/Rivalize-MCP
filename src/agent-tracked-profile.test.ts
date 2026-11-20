/**
 * a tracked competitor gets a teardown, and a stale universe profile is
 * never presented as current.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RivalizeApiError } from './client.js';
import { renderTeardown } from './teardown.js';
import { registerTools } from './tools.js';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function handlers(client: Record<string, unknown>): Map<string, Handler> {
  const registered = new Map<string, Handler>();
  const server = {
    registerTool(name: string, _c: unknown, h: Handler) {
      registered.set(name, h);
    },
  };
  // biome-ignore lint/suspicious/noExplicitAny: structural fakes
  registerTools(server as any, client as any, { allowWrites: false });
  return registered;
}

const NOW = Date.parse('2026-11-06T12:00:00Z');

// The tool reads the clock ("8 days ago"), so the clock is pinned: unpinned, this test
// failed from 7 Nov 2026 on.
beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

const tracked = {
  domain: 'orbitly.example',
  name: 'Orbitly',
  description: 'Win more deals',
  identity: { companyName: 'Orbitly' },
  pricing: { plans: [{ name: 'Team', price: '$1,000', period: 'yearly' }] },
  features: { positioning: ['Battlecards for sales teams'] },
  socialInfluencers: { followerCounts: { linkedin: 15000 } },
  reviews: { sources: [{ source: 'g2', rating: 4.7, reviewCount: 1200 }] },
  fundingHiring: { funding: '$70M' },
  momentum: { momentum: 40, reason: null },
  lastEnrichedAt: '2026-10-29T09:15:08.424Z',
  layerFreshness: { identity: '2026-10-29T09:15:08.424Z', pricing: '2026-10-29T09:15:08.424Z' },
  source: 'tracked_competitor',
  refresh: {
    asOf: '2026-10-29T09:15:08.424Z',
    ageDays: 8,
    cadenceHours: 168,
    cadenceBasis: 'universe_row',
    stale: false,
    notice: null,
  },
};

describe('teardown_competitor on a tracked domain', () => {
  it('returns a real teardown (not a "no profile" pointer) built from the tracked data, dated', async () => {
    const client = { getUniverseCompany: vi.fn(async () => ({ data: tracked })) };
    const res = await handlers(client).get('teardown_competitor')?.({ domain: 'orbitly.example' });
    const text = res?.content[0].text ?? '';
    expect(text).toContain('# Competitor Teardown — Orbitly');
    expect(text).toContain('**Last refreshed:** 8 days ago');
    expect(text).toContain('Built from your tracked competitor');
    expect(text).toContain('## Their pricing');
    expect(text).toContain('Team — $1,000 yearly');
    expect(text).toContain('linkedin: 15,000 followers');
    expect(text).toContain('g2: 4.7★ (1,200 reviews)');
    expect(text).not.toContain('Not yet enriched');
    expect(text).not.toContain('has no Rivalize universe profile');
    // no absence is asserted about layers the account does not hold
    expect(text).not.toContain('No active paid ads');
    expect(text).not.toContain('Not current');
  });

  it('get_universe_company passes the as-of block through intact', async () => {
    const client = { getUniverseCompany: vi.fn(async () => ({ data: tracked })) };
    const res = await handlers(client).get('get_universe_company')?.({ domain: 'orbitly.example' });
    const parsed = JSON.parse(res?.content[0].text ?? '{}');
    expect(parsed.data.source).toBe('tracked_competitor');
    expect(parsed.data.refresh).toMatchObject({ asOf: '2026-10-29T09:15:08.424Z', stale: false });
  });
});

describe('a stale universe profile is not presented as current', () => {
  const stale = {
    ...tracked,
    source: undefined,
    lastEnrichedAt: '2026-06-08T05:00:00.000Z',
    refresh: {
      asOf: '2026-06-08T05:00:00.000Z',
      ageDays: 151,
      cadenceHours: 168,
      cadenceBasis: 'universe_row',
      stale: true,
      notice:
        'As of 2026-06-08 (151 days ago), set to refresh every 7 days, so it is overdue. Treat these figures as of that date, not as current.',
    },
  };

  it('teardown leads with a Not current banner naming the date', () => {
    const md = renderTeardown(stale, { nowMs: NOW, origin: 'https://rivalize.ai' });
    expect(md).toContain('> **Not current.**');
    expect(md).toContain('As of 2026-06-08');
    expect(md).toContain('**Last refreshed:** 151 days ago');
    expect(md).not.toContain('Built from your tracked competitor');
  });

  it('a current profile has no banner (positive companion)', () => {
    const md = renderTeardown(tracked, { nowMs: NOW, origin: 'https://rivalize.ai' });
    expect(md).not.toContain('Not current');
  });

  it('a domain the caller does not track says it is neither in the universe nor tracked', async () => {
    const client = {
      getUniverseCompany: vi.fn(async () => {
        throw new RivalizeApiError(404, 'Not found', 'NOT_FOUND');
      }),
      listAgentCompetitors: vi.fn(async () => {
        throw new RivalizeApiError(403, 'no', 'FORBIDDEN');
      }),
      listCompetitors: vi.fn(async () => ({ data: [], pagination: { total: 0 } })),
    };
    for (const tool of ['teardown_competitor', 'get_universe_company']) {
      const res = await handlers(client).get(tool)?.({ domain: 'nobody.io' });
      const text = res?.content[0].text ?? '';
      expect(text).toContain(
        'is not in the Rivalize universe yet and is not tracked in this workspace',
      );
      expect(text).not.toContain('has no Rivalize universe profile yet');
    }
  });

  it('a payload from an older API with no refresh block renders as before', () => {
    const { refresh: _r, ...legacy } = stale;
    const md = renderTeardown(legacy, { nowMs: NOW, origin: 'https://rivalize.ai' });
    expect(md).not.toContain('Not current');
    expect(md).toContain('**Last refreshed:** 151 days ago');
  });
});
