/**
 * get_competitor_posts and rank_competitor_accounts.
 *
 * The real McpServer over an in-memory transport (the SDK validates arguments against the
 * tool's schema, as a client sees it) with a mocked fetch: no real API call.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stripAiDisclosure } from './__fixtures__/strip-ai-disclosure.js';
import { RivalizeClient } from './client.js';
import { buildServer } from './index.js';

const CONFIG = { apiKey: 'rk_live_fr1198', apiUrl: 'https://api.test.invalid' };
const COMPETITOR = '33333333-3333-4333-8333-333333333333';
const PROJECT = '11111111-1111-4111-8111-111111111111';

const post = (n: number, likes: number | null) => ({
  id: `p${n}`,
  competitorId: COMPETITOR,
  competitorName: 'Orbitly',
  platform: 'tiktok',
  handle: 'orbitly',
  url: `https://www.tiktok.com/@orbitly/video/${n}`,
  postedAt: `2026-10-${String(10 + n).padStart(2, '0')}T09:00:00.000Z`,
  mediaType: 'video',
  caption: `video ${n}`,
  durationSeconds: 30,
  thumbnailUrl: null,
  likes,
  comments: 3,
  shares: 1,
  views: 1000 * n,
  measuredAt: '2026-11-05T00:00:00.000Z',
});

function fetchReturning(body: unknown, status = 200) {
  return vi.fn(
    async (_url: string | URL | Request) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
}

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close().catch(() => {});
});

async function connect(fetchImpl: ReturnType<typeof fetchReturning>) {
  const server = buildServer(new RivalizeClient(CONFIG, fetchImpl as unknown as typeof fetch));
  const client = new Client({ name: 'fr1198', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  open.push(() => client.close());
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args }).catch((e: Error) => e);
  if (res instanceof Error) return { refused: true as const, text: res.message, json: null };
  const r = stripAiDisclosure(res as never) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
  const text = r.content.map((c) => c.text).join('\n');
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // an error message, not JSON
  }
  return { refused: r.isError === true, text, json };
}

describe('get_competitor_posts', () => {
  it('"top 5 videos by likes in the last 90 days" is one call with the filters on the query string', async () => {
    const posts = [post(5, 900), post(4, 700), post(3, 650), post(2, 520), post(1, 510)];
    const fetchImpl = fetchReturning({
      data: { competitorId: COMPETITOR, competitorName: 'Orbitly', posts, coverage: [] },
    });
    const client = await connect(fetchImpl);
    const out = await call(client, 'get_competitor_posts', {
      competitor_id: COMPETITOR,
      type: 'video',
      days: 90,
      sort: 'likes',
      limit: 5,
    });
    expect(out.refused).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchImpl.mock.calls[0][0]));
    expect(url.pathname).toBe(`/api/v1/competitors/${COMPETITOR}/posts`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      type: 'video',
      days: '90',
      sort: 'likes',
      limit: '5',
    });
    const data = (out.json as { data: { posts: Array<ReturnType<typeof post>> } }).data;
    expect(data.posts).toHaveLength(5);
    for (const p of data.posts) {
      expect(p.url).toMatch(/^https:\/\//);
      expect(p.postedAt).toBeTruthy();
      expect(typeof p.likes).toBe('number');
    }
  });

  it('min_likes and platform are sent, and a null like count comes back as null, not 0', async () => {
    const fetchImpl = fetchReturning({
      data: { competitorId: COMPETITOR, posts: [post(1, null)], coverage: [] },
    });
    const client = await connect(fetchImpl);
    const out = await call(client, 'get_competitor_posts', {
      competitor_id: COMPETITOR,
      platform: 'tiktok',
      min_likes: 500,
    });
    const url = new URL(String(fetchImpl.mock.calls[0][0]));
    expect(url.searchParams.get('min_likes')).toBe('500');
    expect(url.searchParams.get('platform')).toBe('tiktok');
    const posts = (out.json as { data: { posts: Array<{ likes: number | null }> } }).data.posts;
    expect(posts[0].likes).toBeNull();
  });

  it('refuses bad input before any request is sent', async () => {
    const fetchImpl = fetchReturning({ data: {} });
    const client = await connect(fetchImpl);
    for (const args of [
      { competitor_id: 'not-a-uuid' },
      { competitor_id: COMPETITOR, days: 0 },
      { competitor_id: COMPETITOR, days: 366 },
      { competitor_id: COMPETITOR, limit: 101 },
      { competitor_id: COMPETITOR, min_likes: -1 },
      { competitor_id: COMPETITOR, type: 'gif' },
      { competitor_id: COMPETITOR, platform: 'myspace' },
      { competitor_id: COMPETITOR, sort: 'worst' },
      { competitor_id: COMPETITOR, extra: 1 },
    ]) {
      const out = await call(client, 'get_competitor_posts', args);
      expect(out.refused, JSON.stringify(args)).toBe(true);
      expect(out.text, JSON.stringify(args)).toContain('Input validation error');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("another user's competitor is the standard COMPETITOR_NOT_FOUND", async () => {
    const fetchImpl = fetchReturning(
      { error: { code: 'NOT_FOUND', message: 'Competitor not found', status: 404 } },
      404,
    );
    const client = await connect(fetchImpl);
    const out = await call(client, 'get_competitor_posts', { competitor_id: COMPETITOR });
    expect(out.refused).toBe(true);
    expect(out.text).toContain('COMPETITOR_NOT_FOUND');
    expect(out.text).toContain('list_competitors');
  });
});

describe('rank_competitor_accounts', () => {
  it('asks for the ranking and returns the per-account 500-likes check, null kept as null', async () => {
    const accounts = [
      { rank: 1, competitorName: 'Orbitly', platform: 'tiktok', hasVideoOver500Likes: true },
      {
        rank: 2,
        competitorName: 'Crayon',
        platform: 'youtube',
        hasVideoOver500Likes: null,
        note: 'x',
      },
    ];
    const fetchImpl = fetchReturning({ data: { projectId: PROJECT, days: 90, accounts } });
    const client = await connect(fetchImpl);
    const out = await call(client, 'rank_competitor_accounts', { project_id: PROJECT, days: 30 });
    const url = new URL(String(fetchImpl.mock.calls[0][0]));
    expect(url.pathname).toBe(`/api/v1/projects/${PROJECT}/social-accounts`);
    expect(url.searchParams.get('days')).toBe('30');
    const got = (out.json as { data: { accounts: typeof accounts } }).data.accounts;
    expect(got.map((a) => a.hasVideoOver500Likes)).toEqual([true, null]);
  });

  it('sends no days when none is given, and refuses bad input', async () => {
    const fetchImpl = fetchReturning({ data: { accounts: [] } });
    const client = await connect(fetchImpl);
    await call(client, 'rank_competitor_accounts', { project_id: PROJECT });
    expect(new URL(String(fetchImpl.mock.calls[0][0])).search).toBe('');
    for (const args of [{ project_id: 'nope' }, { project_id: PROJECT, days: 0 }, {}]) {
      const out = await call(client, 'rank_competitor_accounts', args);
      expect(out.refused, JSON.stringify(args)).toBe(true);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('rank_competitor_accounts keeps every account and every 500-likes answer', () => {
  // A project with 37 accounts: Unshaped, the answer went over 25,000
  // characters and fitJson capped accounts at 10, dropping 4 of the 6 "yes" accounts.
  const longCaption = 'Big launch week! '.repeat(90); // ~1,500 chars, as Instagram captions run
  const bigPost = (n: number, likes: number) => ({
    ...post(n, likes),
    caption: longCaption,
    thumbnailUrl: `https://cdn.test/${'t'.repeat(300)}.jpg`,
  });
  const account = (i: number, yes: boolean | null) => ({
    rank: i + 1,
    competitorId: `c${i}`,
    competitorName: `Rival ${i}`,
    platform: ['instagram', 'linkedin', 'tiktok', 'facebook', 'twitter', 'youtube'][i % 6],
    handle: `rival${i}`,
    url: null,
    followers: 1000 * i,
    postsStored: 20,
    videosStored: 5,
    postsPerWeek: 1.5,
    medianLikesPerPost: 400 - i,
    medianLikesPerVideo: 300 - i,
    medianViewsPerVideo: 9000,
    bestPost: bigPost(i, 900 - i),
    hasVideoOver500Likes: yes,
    videosChecked: 9,
    bestVideo: yes === null ? null : bigPost(i + 100, yes ? 49_100 - i : 120),
    note:
      yes === null
        ? 'No posts stored for this account, so the 500-likes check cannot be answered.'
        : null,
  });
  const answers = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      account(i, i % 6 === 2 ? true : i % 3 === 0 ? null : false),
    );

  it('a 37-account project comes back whole, with the best posts as links', async () => {
    const accounts = answers(37);
    const client = await connect(
      fetchReturning({ data: { projectId: PROJECT, days: 90, accounts } }),
    );
    const out = await call(client, 'rank_competitor_accounts', { project_id: PROJECT });
    const res = out.json as {
      _truncated?: boolean;
      data: {
        accounts: Array<{ rank: number; bestPost: Record<string, unknown>; bestVideo: unknown }>;
        videoOver500Likes: {
          yes: number;
          no: number;
          cannotTell: number;
          accountsWithYes: Array<{ rank: number }>;
        };
      };
    };
    expect(res._truncated).toBeUndefined();
    expect(res.data.accounts.map((a) => a.rank)).toEqual(accounts.map((a) => a.rank));
    expect(res.data.accounts[0].bestPost).toEqual({
      platform: 'tiktok',
      mediaType: 'video',
      postedAt: accounts[0].bestPost.postedAt,
      likes: 900,
      views: accounts[0].bestPost.views,
      url: accounts[0].bestPost.url,
    });
    const yesRanks = accounts.filter((a) => a.hasVideoOver500Likes === true).map((a) => a.rank);
    expect(yesRanks).toHaveLength(6);
    expect(res.data.videoOver500Likes.accountsWithYes.map((a) => a.rank)).toEqual(yesRanks);
    expect(res.data.videoOver500Likes).toMatchObject({ yes: 6, no: 18, cannotTell: 13 });
  });

  it('when even the shaped rows do not fit, the rows are capped but the 500-likes answer is not', async () => {
    const accounts = answers(120);
    const client = await connect(
      fetchReturning({ data: { projectId: PROJECT, days: 90, accounts } }),
    );
    const out = await call(client, 'rank_competitor_accounts', { project_id: PROJECT });
    const res = out.json as {
      _truncated?: boolean;
      _truncation_message?: string;
      data: {
        accounts: unknown[];
        videoOver500Likes: { yes: number; no: number; cannotTell: number };
      };
    };
    expect(res._truncated).toBe(true);
    expect(res.data.accounts.length).toBeLessThan(120);
    expect(res.data.videoOver500Likes).toEqual(
      expect.objectContaining({ yes: 20, no: 60, cannotTell: 40 }),
    );
    expect(res._truncation_message).toContain('videoOver500Likes still covers every account');
    expect(out.text.length).toBeLessThanOrEqual(25_000);
  });
});

describe('tool descriptions tell an agent what the numbers mean', () => {
  it('names the 500 bar, strictly more than, and that null is not 0 or false', async () => {
    const client = await connect(fetchReturning({ data: {} }));
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t.description ?? '']));
    const rank = byName.get('rank_competitor_accounts') ?? '';
    expect(rank).toContain('MORE than 500 likes');
    expect(rank).toContain('null is NOT false');
    const posts = byName.get('get_competitor_posts') ?? '';
    expect(posts).toContain('NOT zero');
    expect(posts).toContain('never matches min_likes');
  });
});

describe('plan wall passes through the MCP unchanged', () => {
  it('a gated answer reaches the agent with gated true and the reason, and the descriptions warn about it', async () => {
    const gated = {
      data: {
        competitorId: COMPETITOR,
        posts: [],
        coverage: [],
        gated: true,
        tier: 'free',
        gatedReason: 'Competitor post data is part of the Starter plan and above.',
      },
    };
    const client = await connect(fetchReturning(gated));
    const out = await call(client, 'get_competitor_posts', { competitor_id: COMPETITOR });
    expect(out.refused).toBe(false);
    const data = (out.json as { data: { gated: boolean; gatedReason: string; posts: unknown[] } })
      .data;
    expect(data.gated).toBe(true);
    expect(data.gatedReason).toContain('Starter');
    expect(data.posts).toEqual([]);
    const { tools } = await client.listTools();
    for (const name of ['get_competitor_posts', 'rank_competitor_accounts']) {
      const d = tools.find((t) => t.name === name)?.description ?? '';
      expect(d, name).toContain('gated true');
    }
  });
});

describe('input hardening for the two new tools: refused before any request', () => {
  const NUL = '\u0000';
  it('NUL in an id, and numbers outside the safe range', async () => {
    const fetchImpl = fetchReturning({ data: {} });
    const client = await connect(fetchImpl);
    const refused: Array<[string, Record<string, unknown>]> = [
      ['get_competitor_posts', { competitor_id: `${COMPETITOR}${NUL}` }],
      ['get_competitor_posts', { competitor_id: `${NUL}${COMPETITOR}` }],
      ['get_competitor_posts', { competitor_id: COMPETITOR, days: 1e21 }],
      ['get_competitor_posts', { competitor_id: COMPETITOR, days: Number.MAX_SAFE_INTEGER + 2 }],
      ['get_competitor_posts', { competitor_id: COMPETITOR, min_likes: 1e21 }],
      [
        'get_competitor_posts',
        { competitor_id: COMPETITOR, min_likes: Number.MAX_SAFE_INTEGER + 2 },
      ],
      ['get_competitor_posts', { competitor_id: COMPETITOR, limit: 1e21 }],
      ['get_competitor_posts', { competitor_id: COMPETITOR, days: 1.5 }],
      ['get_competitor_posts', { competitor_id: COMPETITOR, min_likes: Number.NaN }],
      ['rank_competitor_accounts', { project_id: `${PROJECT}${NUL}` }],
      ['rank_competitor_accounts', { project_id: PROJECT, days: 1e21 }],
      ['rank_competitor_accounts', { project_id: PROJECT, days: Number.MAX_SAFE_INTEGER + 2 }],
    ];
    for (const [name, args] of refused) {
      const out = await call(client, name, args);
      expect(out.refused, `${name} ${JSON.stringify(args)}`).toBe(true);
      expect(out.text, `${name} ${JSON.stringify(args)}`).toContain('Input validation error');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('companion: the same calls with ordinary values do reach the API', async () => {
    const fetchImpl = fetchReturning({ data: { posts: [], coverage: [], accounts: [] } });
    const client = await connect(fetchImpl);
    await call(client, 'get_competitor_posts', {
      competitor_id: COMPETITOR,
      days: 365,
      min_likes: 0,
    });
    await call(client, 'rank_competitor_accounts', { project_id: PROJECT, days: 365 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
