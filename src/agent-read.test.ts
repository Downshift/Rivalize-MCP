/**
 * The core group of a big site (112,590 characters in the case this models)
 * must be readable through get_agent_competitor.
 */
import { describe, expect, it, vi } from 'vitest';
import { shapeAgentRead } from './agent-read.js';
import { CHARACTER_LIMIT } from './markdown-pages.js';
import { registerTools } from './tools.js';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function tool(client: Record<string, unknown>): Handler {
  const registered = new Map<string, Handler>();
  const server = {
    registerTool(name: string, _c: unknown, h: Handler) {
      registered.set(name, h);
    },
  };
  // biome-ignore lint/suspicious/noExplicitAny: structural fakes
  registerTools(server as any, client as any, { allowWrites: false });
  const h = registered.get('get_agent_competitor');
  if (!h) throw new Error('get_agent_competitor not registered');
  return h;
}

const PAGE_TEXT = (i: number) => `page ${i} ${'lorem ipsum dolor '.repeat(260)} end-${i}`;
const HUGE_ONE = `START${'x'.repeat(60_000)}END`; // one page of 60 KB

function payload() {
  const pages = Array.from({ length: 24 }, (_, i) => ({
    url: `https://big.example/p${i}`,
    path: `/p${i}`,
    title: `Title ${i}`,
    text: PAGE_TEXT(i),
    fetched_at: '2026-10-28T10:00:00.000Z',
  }));
  pages.push({
    url: 'https://big.example/huge',
    path: '/huge',
    title: 'Huge',
    text: HUGE_ONE,
    fetched_at: '2026-10-28T10:00:00.000Z',
  });
  return {
    data: {
      id: 'big.example',
      name: 'Big Example',
      level: 'core',
      collection_status: 'collected',
      groups: {
        core: {
          modules: {
            website: {
              status: 'ok',
              source: 'the company website',
              collected_at: 'x',
              data: { title: 'Big', has_pricing_page: true, pages },
            },
            pricing: {
              status: 'ok',
              source: 'the pricing page',
              collected_at: 'x',
              data: { has_pricing_page: true, pages: pages.slice(0, 2) },
            },
            reviews: {
              status: 'ok',
              source: 'App Store',
              collected_at: 'x',
              data: { rating: 4.5 },
            },
          },
        },
        ads_seo: {
          modules: {
            seo: { status: 'ok', source: 'dfs', collected_at: 'x', data: { keywords: [1] } },
          },
        },
      },
      not_in_plan: { extended: { code: 'agent_module_not_in_plan', message: 'not in plan' } },
    },
  };
}

describe('shapeAgentRead: a >100 KB core group', () => {
  it('the fixture is as big as the real failure it models (over 100 KB, core alone)', () => {
    expect(JSON.stringify(payload().data.groups.core).length).toBeGreaterThan(100_000);
  });

  it('reads in pages, each under the limit, and the pages hold every character of the text', () => {
    const res = payload() as unknown as Record<string, unknown>;
    const first = shapeAgentRead(res, { competitor_id: 'big.example', group: 'core' });
    if ('error' in first) throw new Error(first.error);
    const of = (first.output._page as { of: number }).of;
    expect(of).toBeGreaterThan(4);

    const seen = new Map<string, string>(); // `${module}|${url}` -> reassembled text
    const modulesSeen = new Set<string>();
    for (let n = 1; n <= of; n++) {
      const r = shapeAgentRead(res, { competitor_id: 'big.example', group: 'core', page: n });
      if ('error' in r) throw new Error(r.error);
      expect(JSON.stringify(r.output).length).toBeLessThanOrEqual(CHARACTER_LIMIT);
      const page = r.output._page as {
        page: number;
        of: number;
        next_page: number | null;
        message: string;
      };
      expect(page.page).toBe(n);
      expect(page.of).toBe(of);
      expect(page.next_page).toBe(n < of ? n + 1 : null);
      expect(page.message).toContain(`Page ${n} of ${of}`);
      const data = r.output.data as {
        parts: Array<{ group: string; module: string; data?: { pages?: unknown } }>;
      };
      for (const p of data.parts) modulesSeen.add(`${p.group}/${p.module}`);
      const items = data.parts.flatMap((p) =>
        Array.isArray(p.data?.pages)
          ? (p.data.pages as Array<{ url: string; text: string }>).map((item) => ({
              module: p.module,
              item,
            }))
          : [],
      );
      expect(items.length).toBeGreaterThan(0);
      for (const { module, item } of items) {
        const k = `${module}|${item.url}`;
        seen.set(k, (seen.get(k) ?? '') + item.text);
      }
    }
    expect([...modulesSeen].sort()).toEqual(['core/pricing', 'core/reviews', 'core/website']);
    // nothing lost: every website page's text is whole, in order
    for (let i = 0; i < 24; i++) {
      expect(seen.get(`website|https://big.example/p${i}`)).toBe(PAGE_TEXT(i));
    }
    // the 60 KB page was split into chunks and reassembles exactly
    expect(seen.get('website|https://big.example/huge')).toBe(HUGE_ONE);
    expect(seen.get('pricing|https://big.example/p1')).toBe(PAGE_TEXT(1));
  });

  it('names the next call, and lists each module with the pages it spans', () => {
    const r = shapeAgentRead(payload() as unknown as Record<string, unknown>, {
      competitor_id: 'big.example',
      group: 'core',
    });
    if ('error' in r) throw new Error(r.error);
    const page = r.output._page as { next_call: string };
    expect(page.next_call).toBe(
      'get_agent_competitor {"competitor_id":"big.example","group":"core","page":2}',
    );
    const contents = r.output.contents as Array<{ module: string; pages: number[] }>;
    expect(contents.map((c) => c.module)).toEqual(['website', 'pricing', 'reviews']);
    expect(contents[0].pages.length).toBeGreaterThan(1);
  });

  it('module selects one module: a small one comes back whole and unpaged', () => {
    const r = shapeAgentRead(payload() as unknown as Record<string, unknown>, {
      competitor_id: 'big.example',
      group: 'core',
      module: 'reviews',
    });
    if ('error' in r) throw new Error(r.error);
    expect(r.output).not.toHaveProperty('_page');
    const groups = (r.output.data as { groups: Record<string, { modules: object }> }).groups;
    expect(Object.keys(groups.core.modules)).toEqual(['reviews']);
  });

  it('module without group finds it in whichever group holds it', () => {
    const r = shapeAgentRead(payload() as unknown as Record<string, unknown>, {
      competitor_id: 'big.example',
      module: 'seo',
    });
    if ('error' in r) throw new Error(r.error);
    const groups = (r.output.data as { groups: Record<string, unknown> }).groups;
    expect(Object.keys(groups)).toEqual(['ads_seo']);
  });

  it('an unknown module and an out-of-range page are errors that say what exists', () => {
    const res = payload() as unknown as Record<string, unknown>;
    const bad = shapeAgentRead(res, {
      competitor_id: 'big.example',
      group: 'core',
      module: 'nope',
    });
    expect('error' in bad && bad.error).toContain('Modules available: website, pricing, reviews');
    const far = shapeAgentRead(res, { competitor_id: 'big.example', group: 'core', page: 99 });
    expect('error' in far && far.error).toMatch(/page 99 does not exist: this read has \d+ pages/);
  });

  it('data that fits is returned in the original shape, with no paging fields', () => {
    const small = {
      data: {
        id: 'a.com',
        groups: { core: { modules: { reviews: { status: 'ok', data: { rating: 1 } } } } },
      },
    };
    const r = shapeAgentRead(small, { competitor_id: 'a.com' });
    expect('output' in r && r.output).toEqual(small);
    const p2 = shapeAgentRead(small, { competitor_id: 'a.com', page: 2 });
    expect('error' in p2 && p2.error).toContain('1 page');
  });
});

describe('get_agent_competitor through the tool', () => {
  it('group core on the big site is readable (no _omitted groups), page 2 continues', async () => {
    const client = { getAgentCompetitor: vi.fn(async () => structuredClone(payload())) };
    const h = tool(client);
    const one = await h({ competitor_id: 'big.example', group: 'core' });
    const body = JSON.parse(one.content[0].text);
    expect(one.content[0].text.length).toBeLessThanOrEqual(CHARACTER_LIMIT);
    expect(body._truncated).toBeUndefined();
    expect(body._omitted).toBeUndefined();
    expect(body._page.page).toBe(1);
    expect(body.data.parts.length).toBeGreaterThan(0);
    const two = await h({ competitor_id: 'big.example', group: 'core', page: 2 });
    expect(JSON.parse(two.content[0].text)._page.page).toBe(2);
  });

  it('a bad module is an invalid-argument error, not an empty success', async () => {
    const client = { getAgentCompetitor: vi.fn(async () => structuredClone(payload())) };
    const res = await tool(client)({ competitor_id: 'big.example', module: 'nope' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Modules available');
  });
});
