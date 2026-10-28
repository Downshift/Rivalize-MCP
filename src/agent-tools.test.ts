/**
 * The Agent plan MCP tools, against a mocked client and a mocked fetch.
 * Nothing here reaches the network.
 */
import { describe, expect, it, vi } from 'vitest';
import { RivalizeApiError, RivalizeClient } from './client.js';
import { registerTools } from './tools.js';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}>;

function register(client: Record<string, unknown>, allowWrites = true) {
  const registered = new Map<string, Handler>();
  const server = {
    registerTool(name: string, _config: unknown, handler: Handler) {
      registered.set(name, handler);
    },
  };
  // biome-ignore lint/suspicious/noExplicitAny: structural fakes for the SDK server and client
  registerTools(server as any, client as any, { allowWrites });
  return {
    has: (name: string) => registered.has(name),
    /** The handler, or a thrown error: a missing tool must fail the test loudly. */
    get(name: string): Handler {
      const h = registered.get(name);
      if (!h) throw new Error(`tool not registered: ${name}`);
      return h;
    },
  };
}

const SLOTS = {
  data: {
    level: 'core',
    plan: 'Agent Core',
    slots_total: 3,
    slots_used: 1,
    refresh_days: 7,
    slots: [{ slot: 0, competitor: { id: 'rival.com', name: 'Rival', url: 'https://rival.com/' } }],
  },
};
const DATA = {
  data: {
    id: 'rival.com',
    groups: {
      core: { modules: { website: { status: 'ok', source: 'site', collected_at: 'x', data: {} } } },
      ads_seo: { modules: { ads: { status: 'ok', source: 'meta', collected_at: 'x', data: {} } } },
    },
    not_in_plan: { extended: { code: 'agent_module_not_in_plan', message: 'not in plan' } },
  },
};

describe('Agent plan tools', () => {
  it('list_agent_competitors returns the slot list as the API sent it', async () => {
    const client = { listAgentCompetitors: vi.fn(async () => SLOTS) };
    const res = await register(client).get('list_agent_competitors')({});
    expect(client.listAgentCompetitors).toHaveBeenCalledTimes(1);
    expect(res.isError).toBeUndefined();
    expect(JSON.parse(res.content[0].text ?? '{}').data.slots[0].competitor.id).toBe('rival.com');
  });

  it('get_agent_competitor reads by id; group narrows to one group and keeps not_in_plan', async () => {
    const client = { getAgentCompetitor: vi.fn(async () => structuredClone(DATA)) };
    const tools = register(client);
    const all = await tools.get('get_agent_competitor')({ competitor_id: ' rival.com ' });
    expect(client.getAgentCompetitor).toHaveBeenCalledWith('rival.com');
    expect(Object.keys(JSON.parse(all.content[0].text ?? '{}').data.groups)).toEqual([
      'core',
      'ads_seo',
    ]);

    const one = await tools.get('get_agent_competitor')({
      competitor_id: 'rival.com',
      group: 'ads_seo',
    });
    const parsed = JSON.parse(one.content[0].text ?? '{}').data;
    expect(Object.keys(parsed.groups)).toEqual(['ads_seo']);
    expect(parsed.not_in_plan.extended.code).toBe('agent_module_not_in_plan');
  });

  it('set_agent_competitor sends url, name and slot; it is a write tool and absent without writes', async () => {
    const client = {
      setAgentCompetitor: vi.fn(async () => ({ data: { action: 'assigned', slot: { slot: 1 } } })),
    };
    const res = await register(client).get('set_agent_competitor')({
      url: ' https://new.com ',
      name: 'New',
      slot: 1,
    });
    expect(client.setAgentCompetitor).toHaveBeenCalledWith({
      url: 'https://new.com',
      name: 'New',
      slot: 1,
    });
    expect(JSON.parse(res.content[0].text ?? '{}').data.action).toBe('assigned');
    expect(register(client, false).has('set_agent_competitor')).toBe(false);
    // the reads stay available without writes
    expect(register(client, false).has('list_agent_competitors')).toBe(true);
  });

  it.each([
    [
      409,
      'agent_slot_limit',
      'All 3 competitor slots on Agent Core are in use, so a 4th competitor cannot be tracked at once.',
    ],
    [
      409,
      'agent_slot_change_limit',
      'Slot 0 was already changed this calendar month; it can be changed again from 2026-11-01.',
    ],
    [
      403,
      'agent_model_work_not_in_plan',
      'Agent plans return collected data only; battlecards need a dashboard plan. 0 model-backed calls are included.',
    ],
    [403, 'agent_plan_required', 'Tracked-competitor slots belong to the Agent plans.'],
  ])('an Agent refusal (%s %s) reaches the model verbatim, with no generic hint on top', async (status, code, message) => {
    const err = new RivalizeApiError(status, message, code, 'https://rivalize.ai');
    const client = {
      setAgentCompetitor: vi.fn(async () => {
        throw err;
      }),
      getAgentCompetitor: vi.fn(async () => {
        throw err;
      }),
    };
    const tools = register(client);
    for (const [name, args] of [
      ['set_agent_competitor', { url: 'https://a.com' }],
      ['get_agent_competitor', { competitor_id: 'a.com' }],
    ] as const) {
      const res = await tools.get(name)(args);
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toBe(
        `Error (${status} ${code}): ${message.replace(/[.\s]+$/, '')}.`,
      );
    }
  });

  it("an existing tool that needs model work passes the API's Agent refusal through verbatim too", async () => {
    const message =
      'Battlecards are model-written and are not part of Agent Core. Upgrade at /pricing#agent.';
    const client = {
      getBattlecard: vi.fn(async () => {
        throw new RivalizeApiError(403, message, 'agent_model_work_not_in_plan');
      }),
    };
    const res = await register(client).get('get_battlecard')({
      competitor_id: '22222222-2222-4222-8222-222222222222',
    });
    expect(res.content[0].text).toBe(
      `Error (403 agent_model_work_not_in_plan): ${message.replace(/[.\s]+$/, '')}.`,
    );
  });

  it('a dashboard-plan 403 keeps its existing hint (the pass-through is by Agent code only)', async () => {
    const client = {
      listAgentCompetitors: vi.fn(async () => {
        throw new RivalizeApiError(403, 'Forbidden', 'FORBIDDEN');
      }),
    };
    const res = await register(client).get('list_agent_competitors')({});
    expect(res.content[0].text).toContain('requires a higher plan');
  });
});

describe('the client: the three Agent calls', () => {
  it('hits the Agent endpoints with the right method, path and body', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ data: {} }), { status: 200 }),
    );
    const c = new RivalizeClient(
      { apiKey: 'rk_live_x', apiUrl: 'https://api.test.invalid', allowWrites: true },
      fetchImpl as unknown as typeof fetch,
    );
    await c.listAgentCompetitors();
    await c.getAgentCompetitor('a b.com');
    await c.setAgentCompetitor({ url: 'https://a.com', slot: 2 });
    const calls = fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls.map(([u, i]) => `${i.method} ${u}`)).toEqual([
      'GET https://api.test.invalid/api/v1/agent/competitors',
      'GET https://api.test.invalid/api/v1/agent/competitors/a%20b.com',
      'POST https://api.test.invalid/api/v1/agent/competitors',
    ]);
    expect(JSON.parse(String(calls[2][1].body))).toEqual({ url: 'https://a.com', slot: 2 });
  });
});
