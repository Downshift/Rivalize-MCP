/**
 * run_report and get_report_status.
 *
 * The REAL client over a MOCKED fetch: every API call is a fake and nothing
 * here reaches a network or starts a report (a report uses credits, so tests
 * never start one). What is pinned is the HTTP the tools make: which paths, how many
 * POSTs, and that the API's refusal reaches the assistant with its code.
 */
import { describe, expect, it, vi } from 'vitest';
import { RivalizeClient } from './client.js';
import { REPORT_STATUS_POLL_SECONDS, registerTools, shapeReportStatus } from './tools.js';

type Result = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};
type Handler = (args: Record<string, unknown>) => Promise<Result>;

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const JOB = '22222222-2222-4222-8222-222222222222';

const PROJECT = {
  data: {
    id: PROJECT_ID,
    name: 'Acme',
    url: 'https://acme.example',
    competitors: [
      { id: 'c1', name: 'Rival One', website: 'https://one.example', is_active: true },
      { id: 'c2', name: 'Rival Two', website: 'https://two.example', is_active: true },
      { id: 'c3', name: 'Removed', website: 'https://gone.example', is_active: false },
    ],
  },
};

const PREVIEW = {
  data: {
    dry_run: true,
    started: false,
    depth: 'full',
    product_url: 'https://acme.example',
    competitor_urls: ['https://one.example', 'https://two.example'],
    competitor_count: 2,
    dropped: [],
    credits: { to_use: 15, remaining: 120, remaining_after: 105 },
    monthly_report_allowance: {
      counts_toward_allowance: true,
      limit: 20,
      used: 4,
      remaining: 16,
    },
    api_runs_today: { limit: 3, used: 1, remaining: 2, resets_at: '2026-10-29T00:00:00.000Z' },
    expected_duration: '10 to 20 minutes',
    already_started: null,
    message: 'Preview only',
  },
};

const STARTED = {
  data: {
    job_id: JOB,
    status_url: `/api/v1/reports/${JOB}`,
    message: 'Report generation started. Poll status_url for progress.',
    competitor_urls: ['https://one.example', 'https://two.example'],
    dropped: [],
  },
};

interface Call {
  method: string;
  path: string;
  body: unknown;
}

/** A fetch that answers by "METHOD /path" and records every call. */
function makeFetch(
  routes: Record<
    string,
    { status: number; body: unknown } | (() => { status: number; body: unknown })
  >,
) {
  const calls: Call[] = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? 'GET';
    const path = u.pathname.replace(/^\/api/, '');
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const hit = routes[`${method} ${path}`];
    if (!hit) throw new Error(`unexpected request: ${method} ${path}`);
    const r = typeof hit === 'function' ? hit() : hit;
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

function register(fetchImpl: typeof fetch, allowWrites: boolean) {
  const handlers = new Map<string, Handler>();
  const descriptions = new Map<string, string>();
  const server = {
    registerTool(name: string, c: { description?: string }, h: Handler) {
      handlers.set(name, h);
      descriptions.set(name, c.description ?? '');
    },
  };
  const client = new RivalizeClient(
    { apiKey: 'rk_live_test', apiUrl: 'https://api.test', allowWrites },
    fetchImpl,
  );
  // biome-ignore lint/suspicious/noExplicitAny: structural fake for the SDK server
  registerTools(server as any, client, { allowWrites });
  return {
    has: (n: string) => handlers.has(n),
    description: (n: string) => descriptions.get(n) ?? '',
    call(name: string, args: Record<string, unknown>) {
      const h = handlers.get(name);
      if (!h) throw new Error(`tool not registered: ${name}`);
      return h(args);
    },
  };
}

const posts = (calls: Call[]) => calls.filter((c) => c.method === 'POST');
const json = (r: Result) => JSON.parse(r.content[0]?.text ?? '{}');

describe('registration', () => {
  it('run_report is absent without the write switch; get_report_status is always there', () => {
    const { impl } = makeFetch({});
    const off = register(impl, false);
    expect(off.has('run_report')).toBe(false);
    expect(off.has('get_report_status')).toBe(true);
    const on = register(impl, true);
    expect(on.has('run_report')).toBe(true);
    expect(on.has('get_report_status')).toBe(true);
  });

  it('the descriptions carry the warnings the assistant must see', () => {
    const { impl } = makeFetch({});
    const reg = register(impl, true);
    const run = reg.description('run_report');
    expect(run).toMatch(/USES YOUR CREDITS/);
    expect(run).toMatch(/WITHOUT confirm/);
    expect(run).toMatch(/confirm: true/);
    expect(run).toMatch(/3 reports can be started/);
    const status = reg.description('get_report_status');
    expect(status).toContain(`EVERY ${REPORT_STATUS_POLL_SECONDS} SECONDS`);
    expect(REPORT_STATUS_POLL_SECONDS).toBe(30);
  });
});

describe('run_report: preview (no confirm) starts nothing', () => {
  it('reads the project, asks the preview route, makes no real POST', async () => {
    const { impl, calls } = makeFetch({
      [`GET /v1/projects/${PROJECT_ID}`]: { status: 200, body: PROJECT },
      'POST /v1/reports/preview': { status: 200, body: PREVIEW },
    });
    const res = await register(impl, true).call('run_report', { project_id: PROJECT_ID });
    expect(res.isError).toBeFalsy();
    // the only POST is the preview; the real route is never touched
    expect(posts(calls).map((c) => c.path)).toEqual(['/v1/reports/preview']);
    expect(posts(calls)[0]?.body).toEqual({
      product_url: 'https://acme.example',
      competitor_urls: ['https://one.example', 'https://two.example'],
      depth: 'full',
    });
    const d = json(res).data;
    expect(d).toMatchObject({
      started: false,
      preview: true,
      depth: 'full',
      project: { id: PROJECT_ID, name: 'Acme', url: 'https://acme.example' },
      credits: { to_use: 15, remaining: 120, remaining_after: 105 },
      monthly_report_allowance: { remaining: 16 },
      expected_duration: '10 to 20 minutes',
    });
    expect(d.competitors).toEqual([
      { name: 'Rival One', website: 'https://one.example' },
      { name: 'Rival Two', website: 'https://two.example' },
    ]);
    expect(d.message).toMatch(/NOTHING WAS STARTED OR CHARGED/);
    expect(d.to_start).toBe(
      `run_report {"project_id":"${PROJECT_ID}","depth":"full","confirm":true}`,
    );
  });

  it('confirm: false is still a preview', async () => {
    const { impl, calls } = makeFetch({
      [`GET /v1/projects/${PROJECT_ID}`]: { status: 200, body: PROJECT },
      'POST /v1/reports/preview': { status: 200, body: PREVIEW },
    });
    await register(impl, true).call('run_report', { project_id: PROJECT_ID, confirm: false });
    expect(posts(calls).map((c) => c.path)).toEqual(['/v1/reports/preview']);
  });

  it('quick is passed to the preview', async () => {
    const { impl, calls } = makeFetch({
      [`GET /v1/projects/${PROJECT_ID}`]: { status: 200, body: PROJECT },
      'POST /v1/reports/preview': {
        status: 200,
        body: { data: { ...PREVIEW.data, depth: 'quick' } },
      },
    });
    const res = await register(impl, true).call('run_report', {
      project_id: PROJECT_ID,
      depth: 'quick',
    });
    expect((posts(calls)[0]?.body as { depth: string }).depth).toBe('quick');
    expect(json(res).data.depth).toBe('quick');
  });

  it('a preview of a duplicate says confirming returns the run already started', async () => {
    const dup = {
      data: {
        ...PREVIEW.data,
        credits: { to_use: 0, remaining: null, remaining_after: null },
        already_started: { job_id: JOB, status_url: `/api/v1/reports/${JOB}` },
      },
    };
    const { impl } = makeFetch({
      [`GET /v1/projects/${PROJECT_ID}`]: { status: 200, body: PROJECT },
      'POST /v1/reports/preview': { status: 200, body: dup },
    });
    const res = await register(impl, true).call('run_report', { project_id: PROJECT_ID });
    expect(json(res).data.message).toContain(JOB);
    expect(json(res).data.message).toMatch(/charges nothing more/);
  });

  it('a project with no active competitors is said to profile the product alone', async () => {
    const empty = { data: { ...PROJECT.data, competitors: [] } };
    const { impl } = makeFetch({
      [`GET /v1/projects/${PROJECT_ID}`]: { status: 200, body: empty },
      'POST /v1/reports/preview': {
        status: 200,
        body: { data: { ...PREVIEW.data, competitor_urls: [], competitor_count: 0 } },
      },
    });
    const res = await register(impl, true).call('run_report', { project_id: PROJECT_ID });
    expect(json(res).data.note).toMatch(/product alone/);
  });
});

describe('run_report: confirm true makes exactly one real POST', () => {
  it('one POST to /v1/reports with no preview flag, then points at get_report_status', async () => {
    const { impl, calls } = makeFetch({
      [`GET /v1/projects/${PROJECT_ID}`]: { status: 200, body: PROJECT },
      'POST /v1/reports': { status: 202, body: STARTED },
    });
    const res = await register(impl, true).call('run_report', {
      project_id: PROJECT_ID,
      confirm: true,
    });
    expect(res.isError).toBeFalsy();
    expect(posts(calls)).toHaveLength(1);
    expect(posts(calls)[0]?.path).toBe('/v1/reports');
    expect(posts(calls)[0]?.body).toEqual({
      product_url: 'https://acme.example',
      competitor_urls: ['https://one.example', 'https://two.example'],
      depth: 'full',
    });
    const d = json(res).data;
    expect(d).toMatchObject({
      started: true,
      already_started: false,
      report_id: JOB,
      depth: 'full',
    });
    expect(d.next).toContain(`get_report_status {"report_id":"${JOB}"}`);
    expect(d.next).toContain(`${REPORT_STATUS_POLL_SECONDS} seconds`);
  });

  it('an already_started answer is reported as such', async () => {
    const { impl } = makeFetch({
      [`GET /v1/projects/${PROJECT_ID}`]: { status: 200, body: PROJECT },
      'POST /v1/reports': {
        status: 202,
        body: { data: { ...STARTED.data, already_started: true } },
      },
    });
    const res = await register(impl, true).call('run_report', {
      project_id: PROJECT_ID,
      confirm: true,
    });
    expect(json(res).data.already_started).toBe(true);
  });

  it('a project without a product URL is refused before any POST', async () => {
    const { impl, calls } = makeFetch({
      [`GET /v1/projects/${PROJECT_ID}`]: {
        status: 200,
        body: { data: { ...PROJECT.data, url: null } },
      },
    });
    const res = await register(impl, true).call('run_report', {
      project_id: PROJECT_ID,
      confirm: true,
    });
    expect(res.isError).toBe(true);
    expect(posts(calls)).toHaveLength(0);
  });
});

describe('run_report: the API refusal reaches the assistant with its code, verbatim', () => {
  const REFUSALS: Array<[string, number, string, string]> = [
    [
      'free key',
      403,
      'PLAN_REQUIRED',
      'Triggering reports via the API requires the starter plan or higher. Your plan: free.',
    ],
    [
      'Agent key',
      403,
      'agent_model_work_not_in_plan',
      'Starting a report, dossier, discovery or document analysis is not part of the Agent Full plan: Agent plans collect data and your own AI does the analysis, so nothing here starts AI work.',
    ],
    [
      'credits',
      402,
      'INSUFFICIENT_CREDITS',
      'This report requires 15 credits. Upgrade your plan or wait for credit renewal.',
    ],
    [
      'daily cap',
      429,
      'API_REPORT_RUN_LIMIT',
      'At most 3 reports can be started through the API or MCP per UTC day, and 3 have been started today. 0 are left; the allowance resets at 2026-10-29T00:00:00.000Z.',
    ],
  ];

  it.each(
    REFUSALS,
  )('%s: preview and confirm both pass %s through', async (_l, status, code, message) => {
    for (const [route, args] of [
      ['POST /v1/reports/preview', { project_id: PROJECT_ID }],
      ['POST /v1/reports', { project_id: PROJECT_ID, confirm: true }],
    ] as const) {
      const { impl } = makeFetch({
        [`GET /v1/projects/${PROJECT_ID}`]: { status: 200, body: PROJECT },
        [route]: { status, body: { error: { code, message, status } } },
      });
      const res = await register(impl, true).call('run_report', args);
      expect(res.isError).toBe(true);
      const text = res.content[0]?.text ?? '';
      expect(text).toContain(`${status} ${code}`);
      expect(text).toContain(message.replace(/[.\s]+$/, ''));
      // no generic hint is layered over the API's own sentence
      expect(text).not.toMatch(/Rate limit exceeded; wait before retrying/);
      expect(text).not.toMatch(/may belong to another account/);
    }
  });

  it('an unknown project is a PROJECT_NOT_FOUND with the list_projects hint, no POST', async () => {
    const { impl, calls } = makeFetch({
      [`GET /v1/projects/${PROJECT_ID}`]: {
        status: 404,
        body: { error: { code: 'NOT_FOUND', message: 'Project not found', status: 404 } },
      },
    });
    const res = await register(impl, true).call('run_report', { project_id: PROJECT_ID });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain('PROJECT_NOT_FOUND');
    expect(res.content[0]?.text).toContain('list_projects');
    expect(posts(calls)).toHaveLength(0);
  });

  it('the MCP adds no plan check of its own: a plan the API accepts is never refused here', async () => {
    // Every plan name the MCP could be tempted to special-case still gets a POST.
    for (const plan of ['starter', 'growth', 'pro', 'agency', 'something-new']) {
      const { impl, calls } = makeFetch({
        [`GET /v1/projects/${PROJECT_ID}`]: { status: 200, body: PROJECT },
        'POST /v1/reports/preview': { status: 200, body: { data: { ...PREVIEW.data, plan } } },
      });
      const res = await register(impl, true).call('run_report', { project_id: PROJECT_ID });
      expect(res.isError).toBeFalsy();
      expect(posts(calls)).toHaveLength(1);
    }
  });
});

describe('get_report_status', () => {
  it('a running report: processing, poll no sooner than 30 seconds, one GET', async () => {
    const { impl, calls } = makeFetch({
      [`GET /v1/reports/${JOB}`]: {
        status: 200,
        body: { data: { id: JOB, status: 'processing', message: 'Report is being generated.' } },
      },
    });
    const res = await register(impl, false).call('get_report_status', { report_id: JOB });
    expect(calls).toHaveLength(1);
    const d = json(res).data;
    expect(d).toMatchObject({
      report_id: JOB,
      status: 'processing',
      finished: false,
      poll_after_seconds: 30,
    });
    expect(d.next).toMatch(/no less than 30 seconds/);
  });

  it('a finished report: names get_report and does NOT carry the report body', async () => {
    const huge = 'x'.repeat(200_000);
    const { impl } = makeFetch({
      [`GET /v1/reports/${JOB}`]: {
        status: 200,
        body: {
          data: {
            id: JOB,
            job_id: JOB,
            status: 'completed',
            competitors_analyzed: 2,
            product_name: 'Acme',
            report_data: { blob: huge },
            depth: 'full',
            created_at: '2026-10-28T10:00:00.000Z',
          },
        },
      },
    });
    const res = await register(impl, false).call('get_report_status', { report_id: JOB });
    const text = res.content[0]?.text ?? '';
    expect(text.length).toBeLessThan(2_000);
    expect(text).not.toContain('xxxxxxxx');
    const d = json(res).data;
    expect(d).toMatchObject({ status: 'completed', finished: true, competitors_analyzed: 2 });
    expect(d.next).toBe(`Finished. Read it with get_report {"report_id":"${JOB}"}.`);
    expect(d.poll_after_seconds).toBeUndefined();
  });

  it('shapeReportStatus: no_rivals is finished and used no credits; no_competitors is finished', () => {
    expect(shapeReportStatus(JOB, { status: 'no_rivals' })).toMatchObject({
      finished: true,
      next: expect.stringContaining('used no credits'),
    });
    expect(shapeReportStatus(JOB, { status: 'no_competitors' })).toMatchObject({ finished: true });
    expect(shapeReportStatus(JOB, {})).toMatchObject({ status: 'processing', finished: false });
  });

  it('an unknown report is REPORT_NOT_FOUND', async () => {
    const { impl } = makeFetch({
      [`GET /v1/reports/${JOB}`]: {
        status: 404,
        body: { error: { code: 'NOT_FOUND', message: 'Report not found', status: 404 } },
      },
    });
    const res = await register(impl, false).call('get_report_status', { report_id: JOB });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain('REPORT_NOT_FOUND');
  });
});
