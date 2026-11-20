/**
 * teardown_competitor must not send an Agent customer to a
 * dashboard they do not have. Dashboard plans keep the dashboard wording.
 */
import { describe, expect, it, vi } from 'vitest';
import { RivalizeApiError } from './client.js';
import { registerTools } from './tools.js';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function teardown(client: Record<string, unknown>, allowWrites: boolean): Handler {
  const registered = new Map<string, Handler>();
  const server = {
    registerTool(name: string, _c: unknown, h: Handler) {
      registered.set(name, h);
    },
  };
  // biome-ignore lint/suspicious/noExplicitAny: structural fakes
  registerTools(server as any, client as any, { allowWrites });
  const h = registered.get('teardown_competitor');
  if (!h) throw new Error('teardown_competitor not registered');
  return h;
}

const SLOTS = {
  data: {
    slots: [
      { slot: 0, competitor: { id: 'tracked.com', name: 'Tracked' } },
      { slot: 1, competitor: null },
    ],
  },
};
const notInUniverse = () => {
  throw new RivalizeApiError(404, 'Not found', 'NOT_FOUND');
};

describe('teardown_competitor: not in the universe', () => {
  it('Agent key, writes on: points at set_agent_competitor and the slots, never the dashboard', async () => {
    const client = {
      getUniverseCompany: vi.fn(async () => notInUniverse()),
      listAgentCompetitors: vi.fn(async () => SLOTS),
      listCompetitors: vi.fn(async () => ({ data: [], pagination: { total: 0 } })),
    };
    const res = await teardown(client, true)({ domain: 'bigsite.example' });
    const text = res.content[0].text;
    expect(text).toContain('set_agent_competitor');
    expect(text).toContain('list_agent_competitors');
    expect(text.toLowerCase()).not.toContain('dashboard');
    expect(text).not.toContain('add_competitor');
  });

  it('Agent key, writes off: names the endpoint and how to turn writes on, never the dashboard', async () => {
    const client = {
      getUniverseCompany: vi.fn(async () => notInUniverse()),
      listAgentCompetitors: vi.fn(async () => SLOTS),
    };
    const text = (await teardown(client, false)({ domain: 'bigsite.example' })).content[0].text;
    expect(text).toContain('POST /api/v1/agent/competitors');
    expect(text).toContain('write tools');
    expect(text.toLowerCase()).not.toContain('dashboard');
  });

  it('a domain already in an Agent slot says which slot and points at get_agent_competitor', async () => {
    const client = {
      getUniverseCompany: vi.fn(async () => notInUniverse()),
      listAgentCompetitors: vi.fn(async () => SLOTS),
    };
    const text = (await teardown(client, true)({ domain: 'https://www.tracked.com/pricing' }))
      .content[0].text;
    expect(text).toContain('Agent slot 0');
    expect(text).toContain('get_agent_competitor {"competitor_id":"tracked.com"}');
    expect(text.toLowerCase()).not.toContain('dashboard');
  });

  it('a dashboard-plan key keeps the dashboard wording (the Agent slots read is refused)', async () => {
    const client = {
      getUniverseCompany: vi.fn(async () => notInUniverse()),
      listAgentCompetitors: vi.fn(async () => {
        throw new RivalizeApiError(403, 'not an Agent plan', 'agent_plan_required');
      }),
      listCompetitors: vi.fn(async () => ({ data: [], pagination: { total: 0 } })),
    };
    const text = (await teardown(client, false)({ domain: 'bigsite.example' })).content[0].text;
    expect(text).toContain('Add it as a competitor in your Rivalize dashboard');
    expect(text).not.toContain('set_agent_competitor');
  });

  it('a profile that exists but is not enriched: an Agent key gets the slot step in its place', async () => {
    const unenriched = { data: { domain: 'thin.co', name: 'Thin' } };
    const agent = {
      getUniverseCompany: vi.fn(async () => unenriched),
      listAgentCompetitors: vi.fn(async () => SLOTS),
    };
    const a = (await teardown(agent, true)({ domain: 'thin.co' })).content[0].text;
    expect(a).toContain('Not yet enriched');
    expect(a).toContain('set_agent_competitor');
    expect(a.toLowerCase()).not.toContain('dashboard');

    const dash = {
      getUniverseCompany: vi.fn(async () => unenriched),
      listAgentCompetitors: vi.fn(async () => {
        throw new RivalizeApiError(403, 'x', 'agent_plan_required');
      }),
    };
    const d = (await teardown(dash, false)({ domain: 'thin.co' })).content[0].text;
    expect(d).toContain('in your Rivalize dashboard');
  });
});
