/**
 * Rivalize MCP tools.
 *
 * Each tool is a thin wrapper over an authenticated v1 REST endpoint.
 * READ_TOOL_NAMES are always registered. WRITE_TOOL_NAMES (add_competitor and
 * run_report, which spend credits) are registered only when writes are enabled,
 * as is the Agent plan slot write; they are off by default, so the server is
 * read-only unless asked.
 *
 * Tool handlers do no business logic: they validate input (Zod), call the REST
 * client, and shape the response. Tenant isolation, plan gating and rate limits
 * are all enforced by the Rivalize API.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { shapeAgentRead } from './agent-read.js';
import { markToolResult } from './ai-disclosure.js';
import { RivalizeApiError, type RivalizeClient } from './client.js';
import { type FitOptions, fitJson, normalizeListPage } from './fit-json.js';
import { paginateMarkdown, selectSections } from './markdown-pages.js';
import {
  ADD_COMPETITOR_ENRICHMENT_HINT,
  agentSlotHint,
  DASHBOARD_ENRICHMENT_HINT,
  enrichmentHint,
  renderTeardown,
} from './teardown.js';
import {
  normalizeDomain,
  shapeUniverseCompany,
  slimUniverseListRow,
  UNIVERSE_LAYER_KEYS,
  UNIVERSE_LAYER_NAMES,
  type UniverseLayerName,
} from './universe-shape.js';

/**
 * The longest a DNS name can be (RFC 1035). A longer domain cannot exist, and
 * without the bound an oversized argument travels to the API only to fail there
 * (or at the edge, as a 431 or 502).
 */
export const MAX_DOMAIN_LENGTH = 253;

/** How much of the caller's input a message quotes back. */
export const ECHO_MAX = 64;

const NUL = '\u0000';
const NUL_MESSAGE = 'must not contain a NUL (U+0000) character';

/**
 * A NUL in a free-text argument would reach the API, whose database cannot
 * store one, and come back as a 500. No domain, search term, slug, id or
 * section name contains one, so it is refused before any request.
 */
function noNul(s: string): boolean {
  return !s.includes(NUL);
}

/** Free text with a length bound and no NUL. */
function text(max: number) {
  return z.string().max(max).refine(noNul, { message: NUL_MESSAGE });
}

/**
 * Quote the caller's input back, at most ECHO_MAX characters of it, so an
 * oversized argument does not flood the reply. A longer input is cut and its
 * length stated, so the reader knows it was cut.
 */
export function quoteInput(input: string): string {
  if (input.length <= ECHO_MAX) return `"${input}"`;
  return `"${input.slice(0, ECHO_MAX)}…" (${input.length.toLocaleString('en-US')} characters)`;
}

/** The first argument (by name) holding a NUL, for callers that skip schema validation. */
function nulArgument(args: Record<string, unknown>): string | null {
  for (const [name, value] of Object.entries(args ?? {})) {
    const values = Array.isArray(value) ? value : [value];
    if (values.some((v) => typeof v === 'string' && v.includes(NUL))) return name;
  }
  return null;
}

function invalidArgument(name: string, problem: string): ToolResult {
  return {
    content: [{ type: 'text', text: `Error (invalid argument): ${name} ${problem}.` }],
    isError: true,
  };
}

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

// Agent plan tools.
const ListAgentCompetitorsSchema = z.object({}).strict();

const AGENT_GROUPS = ['core', 'ads_seo', 'extended'] as const;

const GetAgentCompetitorSchema = z
  .object({
    competitor_id: text(255)
      .min(1)
      .describe('Competitor id from list_agent_competitors (its domain, e.g. "linear.app")'),
    group: z
      .enum(AGENT_GROUPS)
      .optional()
      .describe(
        'Return only this data group (core, ads_seo, extended). Default: every group your plan includes.',
      ),
    module: text(40)
      .min(1)
      .optional()
      .describe(
        'Return only this module (for example website, pricing, reviews, social, ads, seo). Use it to read one module of a big site; with group, it must be in that group.',
      ),
    page: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe(
        'Page number when the answer is too long for one reply (the reply says "page N of M" and the next call). Default 1.',
      ),
  })
  .strict();

const SetAgentCompetitorSchema = z
  .object({
    url: text(2048).min(1).describe('The competitor website URL'),
    name: text(200).optional().describe('Display name; derived from the URL when omitted'),
    slot: z
      .number()
      .int()
      .min(0)
      .max(2)
      .optional()
      .describe(
        "Slot 0-2 to put it in. Omitted: the first empty slot. Naming a filled slot replaces its competitor and uses that slot's one change this calendar month.",
      ),
  })
  .strict();

/**
 * What a 404 means for one tool. The API answers some routes with a
 * generic NOT_FOUND (reports, a competitor's intelligence and battlecard, a
 * project's competitor add) and others with a specific code; the tool names
 * the specific code either way, so every tool's 404 reads the same and names
 * the list_ call that returns valid ids.
 */
type NotFoundCode = 'REPORT_NOT_FOUND' | 'COMPETITOR_NOT_FOUND' | 'PROJECT_NOT_FOUND';

/** Format an API error into an actionable, agent-readable message. */
function formatError(err: unknown, notFound?: NotFoundCode): ToolResult {
  if (err instanceof RivalizeApiError) {
    // A 404 with no code, or the generic one, takes the tool's own code.
    const code =
      err.status === 404 && notFound && (err.code === undefined || err.code === 'NOT_FOUND')
        ? notFound
        : err.code;
    let hint = codeHint(code);
    if (hint === undefined) {
      switch (err.status) {
        case 401:
          hint = unauthorizedHint(err);
          break;
        case 403:
          hint =
            ' This capability requires a higher plan — free API keys include rate-limited reads. Upgrade at https://rivalize.ai/pricing.';
          break;
        case 404:
          hint = ' It may not exist, or may belong to another account.';
          break;
        case 429:
          hint = ' Rate limit exceeded; wait before retrying.';
          break;
        default:
          hint = '';
      }
    }
    // The API's own message often already ends in "." and, for plan gates,
    // already names the upgrade; appending the generic hint then read
    // "…for sales battlecards.. This capability requires a higher plan…".
    const message = err.message.replace(/[.\s]+$/, '');
    if (/upgrade|pricing/i.test(message) && err.status === 403) hint = '';
    return {
      content: [
        {
          type: 'text',
          text: `Error (${err.status}${code ? ` ${code}` : ''}): ${message}.${hint}`,
        },
      ],
      isError: true,
    };
  }
  return {
    content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
    isError: true,
  };
}

/**
 * A 401 that names the server the key was sent to. A key issued by another
 * Rivalize server (self-hosted, or a test environment) is rejected by the
 * default https://rivalize.ai as "invalid or revoked" even though the key is
 * fine: the server is wrong, and the message should say which server it was.
 */
function unauthorizedHint(err: RivalizeApiError): string {
  const server = err.apiUrl ?? 'the configured server';
  return ` The key was rejected by ${server}. A Rivalize API key only works on the server that issued it: for a self-hosted or non-production Rivalize server, set RIVALIZE_API_URL to that server's origin; for rivalize.ai leave RIVALIZE_API_URL unset. Otherwise check that RIVALIZE_API_KEY is a valid, non-revoked rk_live_ key.`;
}

/**
 * Hints chosen by the API's error CODE where it has one: a generic "verify the
 * id" hint for a missing landscape week would send the agent after the wrong
 * argument. Statuses without a known code fall back to the status hint.
 */
function codeHint(code: string | undefined): string | undefined {
  switch (code) {
    case 'LANDSCAPE_WEEK_NOT_FOUND':
      return ' No landscape is stored for that week. Call get_competitive_landscape without week to see the current view; with format "json" its availableWeeks lists the weeks that are stored.';
    case 'PROJECT_NOT_FOUND':
      return ' Call list_projects for the ids of the projects in your account.';
    case 'REPORT_NOT_FOUND':
      return ' Call list_reports for the ids of the reports in your account.';
    case 'COMPETITOR_NOT_FOUND':
      return ' Call list_competitors for the ids of the competitors in your account.';
    case 'NOT_READY':
      return ' The report exists but is not readable yet (it may be in review); list_reports shows which reports are "completed".';
    case 'UNKNOWN_SECTION':
    case 'SECTION_NOT_IN_REPORT':
      return ' Retry get_report with one of those sections, or without section for the whole report.';
    // The Agent plans' refusals already say what is left and where to go
    // next; the API's sentence is passed through as it is, with no generic hint on top.
    case 'agent_daily_call_cap':
    case 'agent_slot_limit':
    case 'agent_slot_change_limit':
    case 'agent_module_not_in_plan':
    case 'agent_model_work_not_in_plan':
    case 'agent_plan_required':
    case 'api_plan_required':
    // run_report: the API's own sentence says what is left and when it resets
    // (a 429 here is the daily run allowance, not the hourly rate limit).
    case 'API_REPORT_RUN_LIMIT':
    case 'IDEMPOTENCY_KEY_REUSED':
    case 'DAILY_METER_UNAVAILABLE':
      return '';
    case 'NETWORK_ERROR':
      return ' Check the network and RIVALIZE_API_URL; behind a corporate proxy, set HTTPS_PROXY.';
    default:
      return undefined;
  }
}

/**
 * Serialize structured output for the agent. `fitJson` keeps every response
 * under the character limit WITHOUT cutting JSON mid-stream: list rows are
 * dropped from the end with `returned`/`next_offset` stated in-band, long arrays
 * are capped with a count, and whole fields are dropped and listed as omitted.
 */
function asResult(output: Record<string, unknown>, opts: FitOptions = {}): ToolResult {
  const { text, structured } = fitJson(output, opts);
  return structured
    ? { content: [{ type: 'text', text }], structuredContent: structured }
    : { content: [{ type: 'text', text }] };
}

/** Page a Markdown document; every cut says what is left and how to get it. */
function asPagedText(
  md: string,
  page: number | undefined,
  nextCall: (page: number) => string,
  what: string,
): ToolResult {
  const r = paginateMarkdown(md, { page, nextCall, what });
  return r.isError
    ? { content: [{ type: 'text', text: r.text }], isError: true }
    : { content: [{ type: 'text', text: r.text }] };
}

/** `tool {"a":1,...}` with undefined args dropped: the exact next call. */
function callText(tool: string, args: Record<string, unknown>): string {
  const clean = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));
  return `${tool} ${JSON.stringify(clean)}`;
}

/**
 * The account ranking, shaped to fit the MCP's 25,000-character answer.
 *
 * Unshaped, a 37-account project went over the limit
 * and fitJson capped `accounts` at 10, which dropped 4 of the 6 accounts with a video
 * above 500 likes. So:
 *   - each row keeps its figures and the best post / best video as link, date and
 *     numbers only (no caption, thumbnail or duration);
 *   - `videoOver500Likes` is built from EVERY row before any cap: the counts and each
 *     account whose answer is yes, with its video's link. fitJson never drops it.
 */
export function shapeAccountsRanking(res: Record<string, unknown>): Record<string, unknown> {
  const data = (res.data ?? null) as Record<string, unknown> | null;
  if (!(data && Array.isArray(data.accounts))) return res;
  const rows = data.accounts as Array<Record<string, unknown>>;
  const postRef = (p: unknown) => {
    if (!p || typeof p !== 'object') return null;
    const x = p as Record<string, unknown>;
    return {
      platform: x.platform ?? null,
      mediaType: x.mediaType ?? null,
      postedAt: x.postedAt ?? null,
      likes: x.likes ?? null,
      views: x.views ?? null,
      url: x.url ?? null,
    };
  };
  const accounts = rows.map((a): Record<string, unknown> => {
    const { bestVideo, bestPost, ...rest } = a;
    return { ...rest, bestPost: postRef(bestPost), bestVideo: postRef(bestVideo) };
  });
  const answer = (v: boolean | null) =>
    rows.filter((a) => (a.hasVideoOver500Likes ?? null) === v).length;
  const { accounts: _a, ...head } = data;
  return {
    ...res,
    data: {
      ...head,
      videoOver500Likes: {
        yes: answer(true),
        no: answer(false),
        cannotTell: answer(null),
        accountsWithYes: accounts
          .filter((a) => a.hasVideoOver500Likes === true)
          .map((a) => ({
            rank: a.rank,
            competitorName: a.competitorName,
            platform: a.platform,
            handle: a.handle,
            bestVideo: a.bestVideo,
          })),
      },
      accounts,
    },
  };
}

/**
 * The status of a report run, without the report. GET /v1/reports/:id returns
 * the whole stored report once it is finished (hundreds of KB); a status check
 * needs the state and the next call, nothing else.
 */
export function shapeReportStatus(
  requestedId: string,
  d: Record<string, unknown>,
): Record<string, unknown> {
  const status = typeof d.status === 'string' ? d.status : 'processing';
  const finished = status === 'completed' || status === 'no_competitors' || status === 'no_rivals';
  const reportId = typeof d.id === 'string' ? d.id : requestedId;
  const out: Record<string, unknown> = { report_id: reportId, status, finished };
  for (const k of [
    'job_id',
    'message',
    'product_name',
    'product_url',
    'competitors_analyzed',
    'depth',
    'section_count',
    'created_at',
    // false, with the sentence to show, when the report was delivered
    // without its written analysis. Absent from an API that predates it.
    'analysis_ran',
    'analysis_notice',
  ]) {
    if (d[k] !== undefined && d[k] !== null) out[k] = d[k];
  }
  if (!finished) {
    out.poll_after_seconds = REPORT_STATUS_POLL_SECONDS;
    out.next = `Still running. Check again in no less than ${REPORT_STATUS_POLL_SECONDS} seconds; a full report takes about 10 to 20 minutes.`;
  } else if (status === 'no_rivals') {
    out.next =
      'The run stopped before any research and used no credits. Change the project competitors and start again.';
  } else {
    out.next = `Finished. Read it with ${callText('get_report', { report_id: reportId })}.`;
  }
  return out;
}

interface ProjectForRun {
  id?: string;
  name?: string;
  url?: string | null;
  competitors?: Array<{ name?: string; website?: string; is_active?: boolean }>;
}

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

// Input schemas as full z.object() schemas (passed as `inputSchema`). Defining
// them at module scope with explicit types avoids the SDK's deep generic
// inference over inline raw shapes (TS2589 "excessively deep").
const ListUniverseSchema = z
  .object({
    q: text(200).optional().describe('Search name/domain/description'),
    category: text(200).optional().describe('Category slug or name'),
    layer: z
      .enum([
        'identity',
        'pricing',
        'features',
        'ads',
        'social',
        'reviews',
        'funding_hiring',
        'rankings',
      ])
      .optional()
      .describe('Require this intelligence layer to be populated'),
    limit: z.number().int().min(1).max(100).optional().describe('Page size (1-100)'),
    offset: z.number().int().min(0).optional().describe('Pagination offset'),
  })
  .strict();

// A whitespace-only domain must not pass validation and be reported as "not in
// the universe". Trimmed, then required non-empty. The handlers trim again
// (cleanDomain) for callers that bypass the SDK's validation; the two messages
// differ so a test can tell which guard answered.
// At most MAX_DOMAIN_LENGTH characters, and no NUL.
const DomainArg = z
  .string()
  .trim()
  .min(1, 'domain must not be blank')
  .max(MAX_DOMAIN_LENGTH, `domain must be at most ${MAX_DOMAIN_LENGTH} characters`)
  .refine(noNul, { message: `domain ${NUL_MESSAGE}` })
  .describe(`Company domain or a URL on it (at most ${MAX_DOMAIN_LENGTH} characters)`);

const LAYER_ENUM = UNIVERSE_LAYER_NAMES as [UniverseLayerName, ...UniverseLayerName[]];

const GetUniverseSchema = z
  .object({
    domain: DomainArg,
    layers: z
      .array(z.enum(LAYER_ENUM))
      .min(1)
      .optional()
      .describe(
        'Return only these layers (identity, pricing, features, ads, social, reviews, funding_hiring, rankings, signals, momentum). Default: every layer, long arrays capped.',
      ),
  })
  .strict();

const TeardownSchema = z.object({ domain: DomainArg }).strict();

const ListCompetitorsSchema = z
  .object({
    project_id: z.string().uuid().optional().describe('Filter competitors to this project (UUID)'),
    limit: z.number().int().min(1).max(100).optional().describe('Page size (1-100)'),
    offset: z.number().int().min(0).optional().describe('Pagination offset'),
  })
  .strict();

const GetIntelligenceSchema = z
  .object({ competitor_id: z.string().uuid().describe('Competitor UUID from list_competitors') })
  .strict();

const GetBattlecardSchema = z
  .object({ competitor_id: z.string().uuid().describe('Competitor UUID from list_competitors') })
  .strict();

/** the platforms a competitor's posts are stored for ("x" is twitter). */
const POST_PLATFORMS = [
  'tiktok',
  'youtube',
  'twitter',
  'x',
  'instagram',
  'linkedin',
  'facebook',
] as const;

const GetCompetitorPostsSchema = z
  .object({
    competitor_id: z.string().uuid().describe('Competitor UUID from list_competitors'),
    platform: z.enum(POST_PLATFORMS).optional().describe('Only posts from this platform'),
    days: z
      .number()
      .int()
      .min(1)
      .max(365)
      .optional()
      .describe(
        'Only posts published in the last N days (1-365, default 90). Posts with no known publish date are left out.',
      ),
    type: z
      .enum(['video', 'image', 'text'])
      .optional()
      .describe('Only videos, images or text posts'),
    min_likes: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .optional()
      .describe(
        'Only posts with at least this many likes. A post whose likes the platform does not publish never matches.',
      ),
    sort: z
      .enum(['likes', 'views', 'recent'])
      .optional()
      .describe('likes (default), views or recent'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('How many posts to return (1-100, default 20)'),
  })
  .strict();

const RankAccountsSchema = z
  .object({
    project_id: z.string().uuid().describe('Project UUID from list_projects'),
    days: z
      .number()
      .int()
      .min(1)
      .max(365)
      .optional()
      .describe('Look at posts published in the last N days (1-365, default 90)'),
  })
  .strict();

const ListProjectsSchema = z.object({}).strict();

const ListReportsSchema = z
  .object({
    project_id: z.string().uuid().optional().describe('Only reports for this project (UUID)'),
    limit: z.number().int().min(1).max(100).optional().describe('Page size (1-100, default 20)'),
    offset: z.number().int().min(0).optional().describe('Pagination offset'),
  })
  .strict();

const PageArg = z
  .number()
  .int()
  .min(1)
  .optional()
  .describe('1-based page of a long Markdown document; every page is under 25,000 characters');

/**
 * The report's named sections, as the API serves them (`?section=`). Listed
 * here for the tool description only: the API decides, and an unknown name is
 * answered with the sections that report actually has.
 */
export const REPORT_SECTIONS = {
  document: ['tldr', 'biggest-threat', 'blind-spots', 'competitors', 'battlecards', 'actions'],
  topic: [
    'pricing',
    'momentum',
    'app-store',
    'strengths',
    'weaknesses',
    'key-findings',
    'creators',
    'ads',
    'tech-stack',
  ],
} as const;

const GetReportSchema = z
  .object({
    report_id: text(255).min(1).describe('Report id (or its job id) from list_reports'),
    section: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .refine(noNul, { message: NUL_MESSAGE })
      .optional()
      .describe(
        `Return only this named section of the report: ${[...REPORT_SECTIONS.document, ...REPORT_SECTIONS.topic].join(', ')}`,
      ),
    competitor: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine(noNul, { message: NUL_MESSAGE })
      .optional()
      .describe('Return only the sections whose heading names this competitor'),
    page: PageArg,
  })
  .strict();

const GetFreshnessSchema = z
  .object({ project_id: z.string().uuid().describe('Project UUID from list_projects') })
  .strict();

const GetEvidenceSchema = z
  .object({
    project_id: z.string().uuid().describe('Project UUID from list_projects'),
    competitor_id: z
      .string()
      .uuid()
      .optional()
      .describe('A competitor UUID from list_competitors; omit for your own product'),
  })
  .strict();

/** The timeline's lane ids, as the API's `lanes` parameter accepts them. */
const TIMELINE_LANES = ['pricing', 'product', 'people', 'funding', 'content-social'] as const;

const GetTimelineSchema = z
  .object({
    project_id: z.string().uuid().describe('Project UUID from list_projects'),
    days: z.enum(['30', '90', '180']).optional().describe('History window; defaults to 90 days'),
    competitor_id: z.string().uuid().optional().describe('Limit the timeline to one competitor'),
    lanes: z
      .array(z.enum(TIMELINE_LANES))
      .min(1)
      .optional()
      .describe('Only these lanes: pricing, product, people, funding, content-social'),
    format: z
      .enum(['markdown', 'json'])
      .optional()
      .describe('markdown (default, compact, agent-ready) or json (full structure, much larger)'),
    page: PageArg,
  })
  .strict();

const GetLandscapeSchema = z
  .object({
    project_id: z.string().uuid().describe('Project UUID from list_projects'),
    week: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe('Stored ISO week start; omit for current positions'),
    format: z
      .enum(['markdown', 'json'])
      .optional()
      .describe('markdown (default, compact, agent-ready) or json (full structure)'),
    page: PageArg,
  })
  .strict();

const AddCompetitorSchema = z
  .object({
    project_id: z
      .string()
      .uuid()
      .describe('Project UUID (from list_projects) to add competitors to'),
    urls: z
      .array(text(2048).min(1))
      .min(1, 'Provide at least one competitor URL')
      .max(10, 'At most 10 URLs per call')
      .describe('1-10 competitor URLs'),
  })
  .strict();

const RunReportSchema = z
  .object({
    project_id: z
      .string()
      .uuid()
      .describe(
        'Project UUID (from list_projects): its product and active competitors are analysed',
      ),
    depth: z
      .enum(['full', 'quick'])
      .optional()
      .describe(
        'full (default): full research, 15 credits per 5 competitors, uses one of the monthly reports. quick: public pages only, 1 credit per competitor, does not use a monthly report.',
      ),
    confirm: z
      .boolean()
      .optional()
      .describe(
        'Omit (or false) to get a PREVIEW that starts nothing. Send true ONLY after the user has seen the preview and agreed: it starts the report and uses credits.',
      ),
  })
  .strict();

const GetReportStatusSchema = z
  .object({
    report_id: text(255)
      .min(1)
      .describe('The report_id returned by run_report (or an id from list_reports)'),
  })
  .strict();

/** Seconds an assistant must leave between get_report_status calls. */
export const REPORT_STATUS_POLL_SECONDS = 30;

/**
 * Trim a domain argument and check it as the schema does, for callers that
 * bypass the SDK's validation: a blank domain, a NUL or a domain longer than
 * MAX_DOMAIN_LENGTH is refused before any request.
 */
function cleanDomain(domain: string): { domain: string } | { error: ToolResult } {
  const d = domain.trim();
  if (!d) {
    return {
      error: {
        content: [{ type: 'text', text: 'Error: domain must be a non-empty domain or URL.' }],
        isError: true,
      },
    };
  }
  if (!noNul(d)) return { error: invalidArgument('domain', NUL_MESSAGE) };
  if (d.length > MAX_DOMAIN_LENGTH) {
    return {
      error: invalidArgument(
        'domain',
        `must be at most ${MAX_DOMAIN_LENGTH} characters (got ${d.length.toLocaleString('en-US')})`,
      ),
    };
  }
  return { domain: d };
}

interface TrackedMatch {
  id: string;
  name: string;
  projectId: string | null;
  projectName: string | null;
}

const TRACKED_LOOKUP_PAGE = 100;
const TRACKED_LOOKUP_MAX_PAGES = 20;

/**
 * Find a tracked competitor whose website is this domain, walking every
 * page of list_competitors. A server that does not page returns every row on
 * the first call. Any failure means "unknown", never an error: this only
 * chooses which message to show.
 */
async function findTrackedCompetitor(
  client: RivalizeClient,
  domain: string,
): Promise<TrackedMatch | null> {
  const want = normalizeDomain(domain);
  if (!want) return null;
  try {
    let offset = 0;
    for (let i = 0; i < TRACKED_LOOKUP_MAX_PAGES; i++) {
      const res = (await client.listCompetitors({ limit: TRACKED_LOOKUP_PAGE, offset })) as {
        data?: unknown;
        pagination?: { total?: unknown };
      };
      const rows = Array.isArray(res.data) ? (res.data as Array<Record<string, unknown>>) : [];
      for (const r of rows) {
        const site = typeof r.website === 'string' ? normalizeDomain(r.website) : '';
        if (site && site === want && typeof r.id === 'string') {
          return {
            id: r.id,
            name: typeof r.name === 'string' ? r.name : want,
            projectId: typeof r.project_id === 'string' ? r.project_id : null,
            projectName: typeof r.project_name === 'string' ? r.project_name : null,
          };
        }
      }
      const total = typeof res.pagination?.total === 'number' ? res.pagination.total : null;
      offset += rows.length;
      if (total === null || rows.length === 0 || offset >= total) return null;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * A universe lookup that 404s means the company is not in the (shared) universe,
 * or not yet published there. The generic 404 hint ("may belong to another
 * account") is wrong for it. When the domain is already TRACKED in the
 * account, "add it as a competitor" is wrong too: say it is tracked and point
 * at the account-scoped reads that do have data for it.
 */
/**
 * The slots of an Agent-plan key, or null for any other key (or when they cannot be
 * read). Used only on the "not in the universe" path, to give an Agent customer a
 * next step that exists for them: they have no dashboard.
 */
async function agentSlotsOf(
  client: RivalizeClient,
): Promise<Array<{ slot: number; id: string }> | null> {
  // A key the API has told is not an Agent key is not asked again in this session:
  // a dashboard-plan caller pays for this probe at most once.
  if (notAgentKeys.has(client)) return null;
  try {
    const res = (await client.listAgentCompetitors()) as {
      data?: { slots?: Array<{ slot?: unknown; competitor?: { id?: unknown } | null }> };
    };
    const slots = res?.data?.slots;
    if (!Array.isArray(slots)) {
      notAgentKeys.add(client);
      return null;
    }
    return slots.flatMap((s) =>
      s.competitor && typeof s.competitor.id === 'string' && typeof s.slot === 'number'
        ? [{ slot: s.slot, id: s.competitor.id }]
        : [],
    );
  } catch (err) {
    if (err instanceof RivalizeApiError && err.status === 403) notAgentKeys.add(client);
    return null;
  }
}

const notAgentKeys = new WeakSet<object>();

async function notInUniverse(
  client: RivalizeClient,
  domain: string,
  allowWrites: boolean,
): Promise<ToolResult> {
  const agentSlots = await agentSlotsOf(client);
  if (agentSlots) {
    const inSlot = agentSlots.find((s) => s.id === normalizeDomain(domain));
    const text = inSlot
      ? `${quoteInput(domain)} is in your Agent slot ${inSlot.slot}, but it has no Rivalize universe profile, so there is no universe teardown for it. Read what was collected for your slot instead: ${callText('get_agent_competitor', { competitor_id: inSlot.id })}.`
      : `${quoteInput(domain)} is not in the Rivalize universe yet, so there is no profile to report. ${enrichmentHint(allowWrites, true)}`;
    return { content: [{ type: 'text', text }] };
  }
  const tracked = await findTrackedCompetitor(client, domain);
  if (tracked) {
    const where = tracked.projectName ? ` (project "${tracked.projectName}")` : '';
    const reports = tracked.projectId
      ? `${callText('list_reports', { project_id: tracked.projectId })} then get_report with {"competitor":${JSON.stringify(tracked.name)}}`
      : 'list_reports, then get_report with the competitor argument';
    return {
      content: [
        {
          type: 'text',
          text: `${quoteInput(domain)} is already tracked in your account as "${tracked.name}"${where}, but its profile could not be built from your account data, and the Rivalize universe has none. Read what your account has on it instead: ${callText('get_competitor_intelligence', { competitor_id: tracked.id })}, or ${reports}.`,
        },
      ],
    };
  }
  return {
    content: [
      {
        type: 'text',
        text: `${quoteInput(domain)} is not in the Rivalize universe yet and is not tracked in this workspace, so there is no profile to report. ${enrichmentHint(allowWrites)}`,
      },
    ],
  };
}

function isNotFound(err: unknown): boolean {
  return err instanceof RivalizeApiError && err.status === 404;
}

export interface RegisterToolsOptions {
  /** Register WRITE_TOOL_NAMES (add_competitor). Default false: read-only. */
  allowWrites?: boolean;
  /**
   * Origin used for links the tools print (the teardown's "pull this live" and
   * dashboard links). Defaults to https://rivalize.ai; the server passes its
   * RIVALIZE_API_URL so a self-hosted or local server never links to rivalize.ai.
   */
  origin?: string;
  /**
   * Milliseconds to wait before `list_competitors` asks again for a page that
   * has a row whose `brief.state` is `deferred`. Defaults to
   * LIST_DEFERRED_RETRY_MS; tests pass 0.
   */
  deferredRetryMs?: number;
}

/**
 * How many more times `list_competitors` asks for the same page while a row's
 * `brief.state` is `deferred`. The API reads a rival's standing for a few rows
 * per request and keeps what it read, so asking again fills the row in. An
 * agent rarely asks again by itself, so the tool does, a bounded number of
 * times. A server that sends no `brief` never triggers a second request.
 */
export const LIST_DEFERRED_RETRIES = 4;
export const LIST_DEFERRED_RETRY_MS = 1_500;

/** Whether any row on a competitor page has a standing that is still being read. */
export function hasDeferredRow(page: unknown): boolean {
  const rows = (page as { data?: unknown } | null)?.data;
  return (
    Array.isArray(rows) &&
    rows.some((row) => (row as { brief?: { state?: unknown } | null } | null)?.brief?.state === 'deferred')
  );
}

/**
 * The server, with every tool handler's result passed through
 * `markToolResult`. One wrapper at registration, so a tool added tomorrow is
 * marked without its author doing anything.
 */
function withAiDisclosure(server: McpServer): McpServer {
  return new Proxy(server, {
    get(target, prop) {
      if (prop === 'registerTool') {
        // biome-ignore lint/suspicious/noExplicitAny: forwards the SDK's generic signature untouched
        return (name: string, config: any, handler: (...args: any[]) => any) =>
          // biome-ignore lint/suspicious/noExplicitAny: as above
          (target.registerTool as any)(name, config, async (...args: any[]) =>
            markToolResult(await handler(...args)),
          );
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * Register the tools on the given server, backed by the given client.
 * Exported (vs. baked into index.ts) so tests can drive the handlers directly.
 */
export function registerTools(
  rawServer: McpServer,
  client: RivalizeClient,
  opts: RegisterToolsOptions = {},
): void {
  // EU AI Act Article 50: every result a tool returns is marked, whichever tool.
  const server = withAiDisclosure(rawServer);
  const allowWrites = opts.allowWrites === true;

  // ── list_universe_companies ──
  server.registerTool(
    'list_universe_companies',
    {
      title: 'List universe companies',
      description: `List companies from the Rivalize universe — the cross-customer competitive-intelligence dataset (not your own tracked competitors; for those use list_competitors).

Search by keyword, filter by category or by which intelligence layer is populated, and paginate.

Args:
  - q (string, optional): search name/domain/description
  - category (string, optional): category SLUG, e.g. "ai-infra" (names like "AI infrastructure" do not match; each row's categories lists its slugs)
  - layer (string, optional): require a populated layer — one of identity, pricing, features, ads, social, reviews, funding_hiring, rankings
  - limit (number, optional): page size 1-100 (default 50)
  - offset (number, optional): pagination offset (default 0)

Returns compact JSON: { data: Company[], pagination: { total, limit, offset, returned, next_offset }, filters }.
Each Company: domain, name, primaryCategory, categories (slugs), priorityScore, lastEnrichedAt, layers (which layers are populated), layersUpdated, description (at most 120 characters).
If a page does not fit one response, fewer rows come back with _truncated, and pagination.limit/returned say how many; always continue with offset = pagination.next_offset (null when there are no more). Use get_universe_company for one company's full profile.

Use when: "who are the players in <category>?" or "show me universe companies matching <keyword>".`,
      inputSchema: ListUniverseSchema,
      annotations: READ_ONLY,
    },
    async (args: z.infer<typeof ListUniverseSchema>) => {
      const nul = nulArgument(args);
      if (nul) return invalidArgument(nul, NUL_MESSAGE);
      try {
        const res = (await client.listUniverseCompanies(args)) as Record<string, unknown>;
        const data = Array.isArray(res.data) ? res.data.map(slimUniverseListRow) : res.data;
        return asResult(
          { ...res, data },
          { narrowHint: 'Narrow with q, category or layer, or page with offset.' },
        );
      } catch (err) {
        return formatError(err);
      }
    },
  );

  // ── get_universe_company ──
  server.registerTool(
    'get_universe_company',
    {
      title: 'Get universe company',
      description: `Get the universe profile for one company by domain, including every populated intelligence layer (identity, pricing, features, ads, social, reviews, funding/hiring, rankings, signals, momentum).

Args:
  - domain (string, required): the company domain or any URL on it (e.g. "linear.app" or "https://linear.app/pricing"). Normalized server-side.
  - layers (string[], optional): only these layers — any of identity, pricing, features, ads, social, reviews, funding_hiring, rankings, signals, momentum. Asking for fewer layers returns more items of each.

Returns compact JSON: { data: { domain, name, primaryCategory, lastEnrichedAt, layerFreshness, identity, pricing, features, ads, socialInfluencers, reviews, fundingHiring, rankings, signals, momentum, ... } }.
Long arrays (recent posts, ad creatives, sources) are capped; _capped lists kept/total for each. If a layer still does not fit, it is left out and listed in _omitted with the exact call that fetches it. The JSON is always complete and valid.

Every profile carries a refresh block: { asOf, ageDays, cadenceHours, cadenceBasis, stale, notice }. A profile older than its refresh cadence has stale: true and a notice; read its figures as of asOf, not as current. When the shared universe has no published profile for a domain you track, the profile is built from your own tracked competitor data (source: "tracked_competitor", with the same asOf), covering the layers your account holds.

If the domain is not in the universe and you do not track it, says so.

Use when: "give me everything Rivalize knows about <domain>".`,
      inputSchema: GetUniverseSchema,
      annotations: READ_ONLY,
    },
    async (args: z.infer<typeof GetUniverseSchema>) => {
      const cleaned = cleanDomain(args.domain);
      if ('error' in cleaned) return cleaned.error;
      const { domain } = cleaned;
      try {
        const res = (await client.getUniverseCompany(domain)) as Record<string, unknown>;
        const company = res.data;
        let shaped: Record<string, unknown> = res;
        if (company && typeof company === 'object' && !Array.isArray(company)) {
          const { data, capped } = shapeUniverseCompany(company as Record<string, unknown>, {
            layers: args.layers,
          });
          shaped = Object.keys(capped).length
            ? {
                _capped: capped,
                _capped_note: args.layers
                  ? 'Long arrays are capped; kept/total per path in _capped.'
                  : `Long arrays are capped; kept/total per path in _capped. For more of one layer call ${callText('get_universe_company', { domain, layers: ['<layer>'] })}.`,
                ...res,
                data,
              }
            : { ...res, data };
        }
        return asResult(shaped, {
          omitHint: (field) => {
            const layer = UNIVERSE_LAYER_NAMES.find((k) => UNIVERSE_LAYER_KEYS[k] === field);
            return callText('get_universe_company', {
              domain,
              layers: layer ? [layer] : undefined,
            });
          },
          protectedKeys: [
            'domain',
            'name',
            'primaryCategory',
            'lastEnrichedAt',
            'layerFreshness',
            'source',
            'refresh',
          ],
        });
      } catch (err) {
        if (isNotFound(err)) return notInUniverse(client, domain, allowWrites);
        return formatError(err);
      }
    },
  );

  // ── teardown_competitor (the "do a teardown" magic) ──
  server.registerTool(
    'teardown_competitor',
    {
      title: 'Tear down a competitor',
      description: `Produce a full strategy teardown of one competitor by domain — their positioning/hooks, pricing, ads (the creatives they are running), social presence, reviews, hiring, momentum, plus weaknesses to attack. Returns a ready-to-read Markdown teardown, not raw JSON.

This is the one-call competitor teardown: broader than an ad-only teardown, source-backed, and dated (it leads with when the data was last refreshed). Use it to answer "tear down <competitor>" or "what is <competitor>'s strategy and where are they weak?".

Args:
  - domain (string, required): the competitor's domain or any URL on it.

Returns Markdown. Ads count as active only if seen in the last 30 days; an unscored momentum is shown as not scored. Leads with when the data is as of and says when it is older than its refresh cadence. A tracked competitor with no published universe profile gets a teardown built from your account's own data for it (it says so, and has no universe ads, rankings or signals sections). A domain that is neither in the universe nor tracked says so and how to get it enriched.`,
      inputSchema: TeardownSchema,
      annotations: READ_ONLY,
    },
    async (args: z.infer<typeof TeardownSchema>) => {
      const cleaned = cleanDomain(args.domain);
      if ('error' in cleaned) return cleaned.error;
      const { domain } = cleaned;
      try {
        const res = await client.getUniverseCompany(domain);
        const company = (res as { data?: Record<string, unknown> }).data;
        if (!company || typeof company !== 'object') {
          return {
            content: [
              {
                type: 'text' as const,
                text: `No universe profile for ${quoteInput(domain)} yet. ${enrichmentHint(allowWrites)}`,
              },
            ],
          };
        }
        let md = renderTeardown(company, {
          nowMs: Date.now(),
          origin: opts.origin ?? 'https://rivalize.ai',
          canAddCompetitor: allowWrites,
        });
        // A profile that is not enriched yet ends in "add it in your dashboard": an
        // Agent key has no dashboard, so it gets the slot step instead.
        // (With writes on the sentence names add_competitor, a dashboard-plan tool
        // the Agent key is refused: also replaced.)
        const dashboardHints = [DASHBOARD_ENRICHMENT_HINT, ADD_COMPETITOR_ENRICHMENT_HINT];
        if (dashboardHints.some((h) => md.includes(h)) && (await agentSlotsOf(client))) {
          for (const h of dashboardHints) md = md.split(h).join(agentSlotHint(allowWrites));
        }
        return { content: [{ type: 'text' as const, text: md }] };
      } catch (err) {
        if (isNotFound(err)) return notInUniverse(client, domain, allowWrites);
        return formatError(err);
      }
    },
  );

  // ── list_projects ──
  server.registerTool(
    'list_projects',
    {
      title: 'List projects',
      description: `List the projects in YOUR Rivalize account. A project is one of your products and the competitors tracked against it.

Args: none.

Returns JSON: { data: Project[] }. Each Project includes id, name, url, competitor_count, last_refreshed_at, created_at.

Use the returned project id with list_competitors, list_reports, get_strategic_timeline, get_competitive_landscape, get_freshness and get_evidence.

Use when: "what products/projects do I have?", or first, whenever another tool needs a project_id. (For "which competitors am I tracking?" use list_competitors.)`,
      inputSchema: ListProjectsSchema,
      annotations: READ_ONLY,
    },
    async () => {
      try {
        const res = await client.listProjects();
        return asResult(res as Record<string, unknown>);
      } catch (err) {
        return formatError(err);
      }
    },
  );

  // ── list_reports ──
  server.registerTool(
    'list_reports',
    {
      title: 'List reports',
      description: `List the competitive-intelligence reports in YOUR Rivalize account, newest first. Reading is free; this never generates a report.

Args:
  - project_id (string, optional): only this project's reports. Call list_projects first for the id.
  - limit (number, optional): page size 1-100 (default 20)
  - offset (number, optional): pagination offset (default 0)

Returns JSON: { data: Report[], pagination: { total, limit, offset, returned, next_offset } }. Each Report includes id, job_id, project_id, product_name, product_url, competitor_urls, status ("completed" or "unavailable"), created_at, depth ("full" for full research, "quick" for a quick check). A quick check does not buy search traffic, follower counts or the written note on each company, so those are blank in it and marked "Needs full research"; they are not findings.

Use the returned id with get_report.

Use when: "what reports do I have?" or "open my latest report on <product>".`,
      inputSchema: ListReportsSchema,
      annotations: READ_ONLY,
    },
    async (args: z.infer<typeof ListReportsSchema>) => {
      try {
        const res = await client.listReports({
          projectId: args.project_id,
          limit: args.limit,
          offset: args.offset,
        });
        return asResult(res as Record<string, unknown>, {
          narrowHint: 'Filter with project_id, or page with offset.',
        });
      } catch (err) {
        return formatError(err, 'PROJECT_NOT_FOUND');
      }
    },
  );

  // ── get_report ──
  server.registerTool(
    'get_report',
    {
      title: 'Read a report',
      description: `Read one competitive-intelligence report as Markdown: TL;DR, biggest threat, your blind spots, a section per competitor, and cited battlecards where the report has them.

A figure the report's fabrication check could not match to a source is kept with "(not confirmed in the pages read)" after it, and a name or citation it found to belong to another entity is taken out, exactly as in the report itself. Do not try to fill them in.

Args:
  - report_id (string, required): the report id (or its job id) from list_reports
  - section (string, optional): only this named section, plus the report title, date and depth, and a line naming the report's other sections. A whole report is several thousand to over a hundred thousand characters and a section is typically a sixth of it, so ask for the section your question needs. Sections:
      tldr, biggest-threat, blind-spots, actions (what your product should do), battlecards, competitors (every competitor's section in full);
      per competitor, gathered from every competitor's section: pricing, momentum, app-store, strengths, weaknesses, key-findings, creators, ads, tech-stack.
    A report has only the sections it has data for. A name that is not one of this report's sections is an error that lists the sections it does have; retry with one of them. Case, spaces and underscores are ignored ("Key findings" = key-findings).
  - competitor (string, optional): only the sections whose heading names this competitor (its section and its battlecard), plus the report title and date. Case-insensitive. With section, only that competitor's part of the section (e.g. section "pricing" + competitor "Notion").
  - page (number, optional): 1-based page. A report over 25,000 characters is split into pages at section boundaries; every page starts with "Page N of M", the characters that remain, the exact call for the next page, and the sections on later pages. A report that fits is returned whole, unchanged.

Without section, returns the whole report exactly as before. Returns Markdown. 404 if the report is not in your account or is not available.

Use when: "summarise my latest report" (no section, or tldr), "what do competitors charge?" (section "pricing"), "what did the report say about <competitor>?" (use competitor).`,
      inputSchema: GetReportSchema,
      annotations: READ_ONLY,
    },
    async (args: z.infer<typeof GetReportSchema>) => {
      const nul = nulArgument(args);
      if (nul) return invalidArgument(nul, NUL_MESSAGE);
      try {
        const section = args.section?.trim() || undefined;
        // Without section the request is exactly what it always was.
        const res =
          section === undefined
            ? await client.getReportIntelligence(args.report_id)
            : await client.getReportIntelligence(args.report_id, section);
        // A server that predates sections ignores `?section=` and sends the
        // whole report; never hand that back as if it were the section.
        if (section !== undefined && typeof res?.data?.section !== 'string') {
          return {
            content: [
              {
                type: 'text' as const,
                text: `This Rivalize server does not serve report sections yet, so ${quoteInput(section)} could not be read on its own. Call get_report without section for the whole report.`,
              },
            ],
            isError: true,
          };
        }
        const md = res?.data?.markdown;
        if (typeof md !== 'string' || md.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Report ${quoteInput(args.report_id)} returned no readable content.`,
              },
            ],
            isError: true,
          };
        }
        let doc = md;
        if (args.competitor) {
          const sel = selectSections(md, args.competitor);
          if (sel.matched.length === 0) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `No section heading in report ${quoteInput(args.report_id)} names ${quoteInput(args.competitor)}. Sections in this report: ${sel.available.join('; ') || '(none)'}.`,
                },
              ],
              isError: true,
            };
          }
          doc = sel.md;
        }
        return asPagedText(
          doc,
          args.page,
          (page) =>
            callText('get_report', {
              report_id: args.report_id,
              section,
              competitor: args.competitor,
              page,
            }),
          section === undefined ? 'report' : `report section "${section}"`,
        );
      } catch (err) {
        return formatError(err, 'REPORT_NOT_FOUND');
      }
    },
  );

  // ── list_competitors ──
  server.registerTool(
    'list_competitors',
    {
      title: 'List tracked competitors',
      description: `List the competitors tracked in YOUR Rivalize account (tenant-isolated). Answers "which competitors am I tracking?".

Args:
  - project_id (string, optional): only one project's competitors. Call list_projects first for the id.
  - limit (number, optional): page size 1-100
  - offset (number, optional): pagination offset (default 0)

Returns JSON: { data: Competitor[], pagination: { total, limit, offset, returned, next_offset } }. Each Competitor includes id, project_id, project_name, name, website, threat_level, momentum_score, and brief where the server provides it. Keep paging with offset = pagination.next_offset until it is null.

momentum_score is the rival's momentum score, and threat_level is only that score's band (critical, high, medium, low, or unknown when there is no score): it is not a second assessment, so do not rank by it.

brief, when present, is how the rival stands as your workspace's Brief shows it: brief.standing is "ahead" (the rival is ahead of you), "behind", "even" or "no_read"; brief.standing_label is the Brief's own words; brief.as_of is the date of the report it was read from; brief.state is "read", "not_in_run" (no finished report covered this rival), "no_run", "unreadable" or "deferred" (still being read: the tool asks again a few times before it answers, so a row still "deferred" means call again in a moment).

To pick the "top" or biggest competitor: rank by brief.standing when present ("ahead" first, then "even", then "behind"), otherwise by momentum_score; break ties by highest momentum_score. A rival whose brief.state is not "read" has no standing yet: say so rather than ranking it by standing.

With a competitor's id: get_competitor_intelligence (its latest intelligence), get_battlecard (sales battlecard), get_evidence with its project_id (the sources behind its facts). For what a report said about it: list_reports for the project, then get_report with competitor set to its name. For when it was last observed: get_freshness for its project.

Use when: "which competitors am I tracking?", "who is my top competitor?", or before any per-competitor read.`,
      inputSchema: ListCompetitorsSchema,
      annotations: READ_ONLY,
    },
    async (args: z.infer<typeof ListCompetitorsSchema>) => {
      try {
        const ask = () =>
          client.listCompetitors({
            projectId: args.project_id,
            limit: args.limit,
            offset: args.offset,
          });
        let res = await ask();
        // A row whose standing is still being read is asked for again, a
        // bounded number of times; what is still `deferred` after that is
        // returned as such. Rows without `brief` are never deferred.
        const retryMs = opts.deferredRetryMs ?? LIST_DEFERRED_RETRY_MS;
        for (let i = 0; i < LIST_DEFERRED_RETRIES && hasDeferredRow(res); i++) {
          if (retryMs > 0) await new Promise((resolve) => setTimeout(resolve, retryMs));
          res = await ask();
        }
        return asResult(
          normalizeListPage(res as Record<string, unknown>, {
            limit: args.limit,
            offset: args.offset,
          }),
          { narrowHint: 'Filter with project_id, or page with offset.' },
        );
      } catch (err) {
        return formatError(err, 'PROJECT_NOT_FOUND');
      }
    },
  );

  // ── get_competitor_intelligence ──
  server.registerTool(
    'get_competitor_intelligence',
    {
      title: 'Get competitor intelligence',
      description: `Get the latest stored intelligence for one tracked competitor.

Args:
  - competitor_id (string, required): the competitor UUID (from list_competitors)

Returns JSON: { data: { competitor_name, momentum_score, intelligence, latest_snapshot, source, source_report_id, source_report_date, report } }. source says where the data comes from: "snapshot" (a stored intelligence snapshot), "report" (the competitor's latest report in your account; report holds swot, strengths, weaknesses, key_findings, tech_stack, pricing_tiers, social and reviews, and source_report_id names the report for get_report), or "none" (the competitor appears in no snapshot or report yet). Every field is present only when measured: null or absent means "not measured", not "none". Claims the report withheld as unverified are withheld here too.

Returns a 404 error if the competitor does not belong to your account (tenant isolation).

Use when: "what's the latest intel on <competitor>?" after finding its id via list_competitors. For the full narrative, get_report with competitor is richer.`,
      inputSchema: GetIntelligenceSchema,
      annotations: READ_ONLY,
    },
    async (args: z.infer<typeof GetIntelligenceSchema>) => {
      try {
        const res = await client.getCompetitorIntelligence(args.competitor_id);
        return asResult(res as Record<string, unknown>);
      } catch (err) {
        return formatError(err, 'COMPETITOR_NOT_FOUND');
      }
    },
  );

  // ── get_competitor_posts ──
  server.registerTool(
    'get_competitor_posts',
    {
      title: "Get a competitor's social posts by likes",
      description: `Get one competitor's stored social posts with their likes, comments, shares and views, best first. Answers "which of their posts are winning?" and "<competitor>'s top 5 videos by likes in the last 90 days".

Args:
  - competitor_id (string, required): the competitor UUID (from list_competitors)
  - platform ("tiktok" | "youtube" | "twitter" | "instagram" | "linkedin" | "facebook", optional): one platform ("x" means twitter)
  - days (number, optional): published in the last N days, 1-365, default 90. Posts with no known publish date are left out.
  - type ("video" | "image" | "text", optional): only that kind of post
  - min_likes (number, optional): at least this many likes
  - sort ("likes" | "views" | "recent", optional): default likes
  - limit (number, optional): 1-100, default 20

Returns JSON: { data: { competitorId, competitorName, filters, posts, coverage } }. Each post has url (the link), postedAt, platform, handle, mediaType, caption, durationSeconds, thumbnailUrl, likes, comments, shares, views and measuredAt (when those figures were read). \`coverage\` lists, per account, how many posts are stored and whether its likes are readable, so an empty list says why it is empty.

A null figure means the platform did not publish it; it is NOT zero. Do not rank or compare a null like count as 0, and do not say a post "has no likes" when likes is null. A post with null likes never matches min_likes. A mediaType of null means the type is unknown. Only stored data is read: nothing is fetched live and no credits are used.

Plan: post data is part of the Starter plan and above. On a free plan the answer has gated true and a gatedReason, and posts is empty because of the plan, not because nothing was collected: say so and do not report "no posts".

Use when: "<competitor>'s top 5 videos by likes in the last 90 days" (type video, sort likes, limit 5), "what are <competitor>'s best posts on LinkedIn?", or finding posts worth copying. To compare the competitors' accounts with each other, use rank_competitor_accounts.`,
      inputSchema: GetCompetitorPostsSchema,
      annotations: READ_ONLY,
    },
    async (args: z.infer<typeof GetCompetitorPostsSchema>) => {
      try {
        const res = await client.getCompetitorPosts(args.competitor_id, {
          platform: args.platform,
          days: args.days,
          type: args.type,
          minLikes: args.min_likes,
          sort: args.sort,
          limit: args.limit,
        });
        return asResult(res as Record<string, unknown>, {
          narrowHint: 'Narrow with limit, platform, type or min_likes.',
        });
      } catch (err) {
        return formatError(err, 'COMPETITOR_NOT_FOUND');
      }
    },
  );

  // ── rank_competitor_accounts ──
  server.registerTool(
    'rank_competitor_accounts',
    {
      title: 'Rank competitor social accounts',
      description: `Rank a project's competitor social accounts by how well they post. Answers "which of my competitors' accounts post best?" and "does each have a video above 500 likes?".

Args:
  - project_id (string, required): the project UUID (from list_projects)
  - days (number, optional): look at posts published in the last N days, 1-365, default 90

Returns JSON: { data: { projectId, days, videoOver500Likes, accounts } }. videoOver500Likes answers the 500-likes check over EVERY account, even when a long accounts list has to be shortened to fit: { yes, no, cannotTell, accountsWithYes: [{ rank, competitorName, platform, handle, bestVideo }] }; answer "which accounts have a video over 500 likes?" from it. accounts is best first (rank 1 is best): accounts are ranked by medianLikesPerPost (median likes over the account's posts in the window, every type, so a LinkedIn page is scored too), then median likes and views per video, then posts per week; accounts with no post in the window, or none with a published like count, follow. Each account has competitorName, platform, handle, url, followers, postsStored and videosStored (in the window), postsPerWeek, medianLikesPerPost, medianLikesPerVideo, medianViewsPerVideo, bestPost (its top post in the window by likes: platform, type, date, likes, views, link), hasVideoOver500Likes with videosChecked and bestVideo (its top stored video by likes, any date, with link and date), and a note.

hasVideoOver500Likes is the cross-team rule "an account worth copying has at least one video with MORE than 500 likes". It reads EVERY stored post of the account, whatever its date (days does not narrow it; bestVideo.postedAt says when the hit was). true or false when it can be answered. It is null when it cannot: no videos are stored for the account, or the platform does not publish like counts (LinkedIn posts carry no video flag, so a LinkedIn account is always null here). null is NOT false: say "cannot tell" and give the note, never "no". Likewise a null medianLikesPerVideo or postsPerWeek means unknown, not zero. Only stored data is read: nothing is fetched live and no credits are used.

Plan: the ranking is part of the Starter plan and above. On a free plan the answer has gated true and a gatedReason, and accounts is empty because of the plan: say so, never "no accounts".

Use when: "which of my competitors' accounts post best?", "which accounts have a video over 500 likes?", or choosing whose posts to copy. For one competitor's individual posts, use get_competitor_posts.`,
      inputSchema: RankAccountsSchema,
      annotations: READ_ONLY,
    },
    async (args: z.infer<typeof RankAccountsSchema>) => {
      try {
        const res = await client.getSocialAccounts(args.project_id, args.days);
        return asResult(shapeAccountsRanking(res as Record<string, unknown>), {
          narrowHint:
            'videoOver500Likes still covers every account; for the rows left out, use a shorter days window.',
          protectedKeys: ['videoOver500Likes', 'projectId', 'days'],
        });
      } catch (err) {
        return formatError(err, 'PROJECT_NOT_FOUND');
      }
    },
  );

  // ── get_battlecard ──
  server.registerTool(
    'get_battlecard',
    {
      title: 'Get competitor battlecard',
      description: `Get the cited sales battlecard for one tracked competitor — Why We Win, Their Weaknesses, Objection Handlers, Discovery Questions. Every claim carries citations resolving to the collected source; claims that could not be cited were WITHHELD, not asserted.

Args:
  - competitor_id (string, required): the competitor UUID (from list_competitors)

Returns JSON: { data: { status, sections_empty, sections_locked, withheld_reason?, battlecard, markdown, generated_at, intelligence_date, source, report_id?, report_date? } }.
- status is read off the card's four sections. "ready": every section carries a cited claim. "partial": at least one section has none; sections_empty names them (sections_locked names the ones locked until the user's company profile is complete, which were not withheld). "withheld": the card exists but no section carries a claim; withheld_reason says why. Do not treat "partial" or "withheld" as a complete card.
- "markdown" is a paste-ready cited card and states a partial or withheld card up front. source "generated" is a card generated from the dashboard's Battlecard tab; source "report" is the battlecard inside the competitor's latest report, and report_id names that report (get_report reads it in full).
- status "not_generated": no card can be served — none generated, and the latest report has none (or only one in an older format that fails the citation contract). The user generates one from the dashboard's Battlecard tab.

Requires a Pro-plan API key (403 PLAN_REQUIRED below Pro). 404 if the competitor is not in your account (tenant isolation).

Use when: "give me sales ammo against <competitor>", "how do we win vs <competitor>", or prepping a call.`,
      inputSchema: GetBattlecardSchema,
      annotations: READ_ONLY,
    },
    async (args: z.infer<typeof GetBattlecardSchema>) => {
      try {
        const res = await client.getBattlecard(args.competitor_id);
        return asResult(res as Record<string, unknown>);
      } catch (err) {
        return formatError(err, 'COMPETITOR_NOT_FOUND');
      }
    },
  );

  // ── get_strategic_timeline ──
  server.registerTool(
    'get_strategic_timeline',
    {
      title: 'Get strategic timeline',
      description: `Get a receipt-linked timeline of competitor activity across Pricing, Product, People, Funding, and Content/Social lanes.

Args:
  - project_id (string, required): the project's UUID. Call list_projects first for the id.
  - days ("30" | "90" | "180", optional): history window, default 90
  - competitor_id (string, optional): isolate one competitor
  - lanes (string[], optional): only these lanes, any of pricing, product, people, funding, content-social
  - format ("markdown" | "json", optional): markdown by default (compact); json for the full structure
  - page (number, optional): 1-based page of the Markdown. A timeline over 25,000 characters is split at lane/move boundaries; each page says "Page N of M", what remains and the exact next call.

Returns agent-ready Markdown by default (JSON on request) with structured events, seven-day move clusters, tracking-since dates, and evidence URLs. History is never backfilled before Rivalize began tracking. Full history/all-competitor access requires Pro; lower plans can request one competitor for 30 days.

Use when: "what strategic moves have competitors made this quarter?" or "show the arc behind recent competitor activity".`,
      inputSchema: GetTimelineSchema,
      annotations: READ_ONLY,
    },
    async (args: z.infer<typeof GetTimelineSchema>) => {
      try {
        const days = Number(args.days ?? '90') as 30 | 90 | 180;
        if (args.format === 'json') {
          const res = await client.getStrategicTimeline(
            args.project_id,
            days,
            args.competitor_id,
            args.lanes,
          );
          return asResult(res as Record<string, unknown>, {
            narrowHint:
              'For the whole timeline use format "markdown" (paged with page), or narrow with competitor_id or a shorter days window.',
          });
        }
        // Markdown by default: the JSON form of a busy project's timeline runs
        // to tens of kilobytes and reaches the 25,000-character limit within
        // 90 days, while the API's agent Markdown carries the same timeline in
        // roughly a tenth of the space.
        return asPagedText(
          await client.getStrategicTimelineMarkdown(
            args.project_id,
            days,
            args.competitor_id,
            args.lanes,
          ),
          args.page,
          (page) =>
            callText('get_strategic_timeline', {
              project_id: args.project_id,
              days: args.days,
              competitor_id: args.competitor_id,
              lanes: args.lanes,
              page,
            }),
          'timeline',
        );
      } catch (err) {
        return formatError(err, 'PROJECT_NOT_FOUND');
      }
    },
  );

  // ── get_competitive_landscape ──
  server.registerTool(
    'get_competitive_landscape',
    {
      title: 'Get competitive landscape',
      description: `Get the current or stored weekly competitor positions on activity × strategic importance.

Args:
  - project_id (string, required): the project's UUID. Call list_projects first for the id.
  - week (YYYY-MM-DD, optional): a stored ISO week; omit for current positions. The json format lists stored weeks in availableWeeks.
  - format ("markdown" | "json", optional): markdown by default; json for the full structure
  - page (number, optional): 1-based page when the Markdown is over 25,000 characters; each page names the next call

Returns agent-ready Markdown by default (JSON on request) with coordinates, trailing signal counts, momentum, latest headlines, importance source, available weeks, and the honest tracking-start date. Historical weeks are never synthesized. History requires Pro; the current view remains available below Pro.

Use when: "who is the biggest moving threat?" or "who moved most this month?".`,
      inputSchema: GetLandscapeSchema,
      annotations: READ_ONLY,
    },
    async (args: z.infer<typeof GetLandscapeSchema>) => {
      try {
        if (args.format === 'json') {
          const res = await client.getLandscape(args.project_id, args.week);
          return asResult(res as Record<string, unknown>, {
            narrowHint: 'For the whole landscape use format "markdown" (paged with page).',
          });
        }
        return asPagedText(
          await client.getLandscapeMarkdown(args.project_id, args.week),
          args.page,
          (page) =>
            callText('get_competitive_landscape', {
              project_id: args.project_id,
              week: args.week,
              page,
            }),
          'landscape',
        );
      } catch (err) {
        return formatError(err, 'PROJECT_NOT_FOUND');
      }
    },
  );

  // ── get_freshness ──
  server.registerTool(
    'get_freshness',
    {
      title: 'Get data freshness',
      description: `How current your Rivalize data is for one project: the date of its latest report, and for EACH tracked competitor the date Rivalize last actually observed it and how. Reading is free; this never fetches anything.

Args:
  - project_id (string, required): the project's UUID. Call list_projects first for the id.

Returns JSON: { data: { project_id, project_name, latest_report: { id, created_at, depth } | null, competitors: Competitor[], observation_kinds } }.
Each Competitor: competitor_id, name, website, status ("observed" or "never_observed"), last_observed_at, last_observed_by, and observations with the newest date of each kind:
  - report_run: a report you can read analysed it and its crawl read the site (report_id names the report)
  - site_crawl: a stored crawl of its site
  - monitoring_page_capture: a monitoring check fetched one of its pages (page_type, url)
  - search_check: a monitoring search asked whether anything changed. It does not read the site, so it never sets last_observed_at.
last_observed_at is the newest of report_run, site_crawl and monitoring_page_capture, and last_observed_by names which. A competitor nothing has observed is "never_observed" with null dates: no date is ever estimated or filled in, and a record's edit time is never used as an observation date. A failed crawl, a rejected report and a baseline copied from stored data are not observations.

Returns a 404 error if the project is not in your account.

Use when: "how fresh is this data?", "when did we last look at <competitor>?", or before relying on a figure, to say how old it is.`,
      inputSchema: GetFreshnessSchema,
      annotations: READ_ONLY,
    },
    async (args: z.infer<typeof GetFreshnessSchema>) => {
      try {
        const res = await client.getProjectFreshness(args.project_id);
        return asResult(res as Record<string, unknown>);
      } catch (err) {
        return formatError(err, 'PROJECT_NOT_FOUND');
      }
    },
  );

  // ── get_evidence ──
  server.registerTool(
    'get_evidence',
    {
      title: 'Get evidence',
      description: `The sources behind the facts for ONE subject: your own product (omit competitor_id) or one tracked competitor. Taken from the latest readable report in the project that analysed the subject, as the report serves it: claims the report withholds as unverified are withheld here too, and a figure the report has corrected shows the corrected value.

Args:
  - project_id (string, required): the project's UUID. Call list_projects first for the id.
  - competitor_id (string, optional): a competitor UUID from list_competitors (it must be in this project). Omit for your own product.

Returns JSON: { data: { project_id, subject: { kind ("product" | "competitor"), competitor_id, name, website }, report: { id, created_at } | null, source_count, unlinked_attributions, off_entity_withheld, sources: Source[] } }.
Each Source: url, supports (what it backs: the fact, claim or section, as the report states it), kinds (attribution, page_read, press, strength_receipt, fact, battlecard, interpretation), observed_at (the date of the report run that read it) and, for press, published_at (the article's own date).
unlinked_attributions counts data points the report attributed to a description rather than a URL; they are not listed, and no URL is made up for them. off_entity_withheld counts sources a web search for the subject's name returned that are not about the subject (not on its domain, and neither the URL nor any text the report keeps for it names the subject, e.g. a stock page for a similarly named company); they are not listed. With no readable report on the subject, sources is empty and note says why.

Returns a 404 error if the project is not in your account, or if competitor_id is not a competitor in this project (another account's competitor is reported exactly like one that does not exist).

Use when: "where does that come from?", "show me the sources for <competitor>'s pricing", or to cite a claim.`,
      inputSchema: GetEvidenceSchema,
      annotations: READ_ONLY,
    },
    async (args: z.infer<typeof GetEvidenceSchema>) => {
      try {
        const res = await client.getEvidence(args.project_id, args.competitor_id);
        return asResult(res as Record<string, unknown>, {
          narrowHint:
            'The source list is long: ask about one competitor at a time with competitor_id.',
        });
      } catch (err) {
        return formatError(err, 'PROJECT_NOT_FOUND');
      }
    },
  );

  // ── list_agent_competitors (Agent plans) ──
  server.registerTool(
    'list_agent_competitors',
    {
      title: 'List tracked competitors (Agent plan)',
      description: `List the competitor slots of your Rivalize Agent plan: who is tracked, when each was last collected, when it refreshes next, and how many slot changes are left this calendar month. Reading is free and calls no vendor. Only Agent plan keys use this; other plans use list_competitors.

Args: none.

Returns JSON: { data: { level, plan, slots_total, slots_used, refresh_days, slots: [{ slot, competitor: { id, name, url } | null, collection_status, last_collected_at, next_refresh_at, changes_left_this_month, changes_reset_at }] } }.
Use competitor.id with get_agent_competitor.

Use when: "which competitors am I tracking?", "when does my data refresh?", "can I swap a competitor?".`,
      inputSchema: ListAgentCompetitorsSchema,
      annotations: READ_ONLY,
    },
    async () => {
      try {
        const res = await client.listAgentCompetitors();
        return asResult(res as Record<string, unknown>);
      } catch (err) {
        return formatError(err);
      }
    },
  );

  // ── get_agent_competitor (Agent plans) ──
  server.registerTool(
    'get_agent_competitor',
    {
      title: "Get a tracked competitor's collected data (Agent plan)",
      description: `Read the raw data Rivalize collected about one competitor in your Agent plan, by data group (core: website pages, pricing page, App Store reviews, social profiles; ads_seo: paid ads, search and traffic; extended: everything else collected). Each module carries its source, status and collected_at. There is NO analysis in it: the reasoning is yours. Reading is free and calls no vendor.

Args:
  - competitor_id (string, required): the competitor id from list_agent_competitors (its domain)
  - group (string, optional): core | ads_seo | extended; only that group
  - module (string, optional): only that module (website, pricing, reviews, social, ads, seo, ...), to read one module of a big site
  - page (integer, optional): when the answer is longer than one reply it is read in pages: the reply carries _page ("page N of M" and the exact next call) and contents (each module and the pages it spans). Nothing is left out; a long module is split by item (a website's pages) or in consecutive text chunks (partial says which).

Returns JSON: { data: { id, name, url, slot, level, collection_status, collected_at, next_refresh_at, groups: { <group>: { modules: { <module>: { status, source, collected_at, data, error } } } }, not_in_plan: { <group>: { code, message } } } }.
A group your plan level does not include is absent from groups and named in not_in_plan with code agent_module_not_in_plan. collection_status "pending" means the first collection has not finished yet.

Use when: "what does <competitor> charge?", "what ads is <competitor> running?", "read everything you have on <competitor>".`,
      inputSchema: GetAgentCompetitorSchema,
      annotations: READ_ONLY,
    },
    async (args: z.infer<typeof GetAgentCompetitorSchema>) => {
      const nul = nulArgument(args);
      if (nul) return invalidArgument(nul, NUL_MESSAGE);
      try {
        const res = (await client.getAgentCompetitor(args.competitor_id.trim())) as {
          data?: { groups?: Record<string, unknown> } & Record<string, unknown>;
        };
        const shaped = shapeAgentRead(res as Record<string, unknown>, {
          ...args,
          competitor_id: args.competitor_id.trim(),
        });
        if ('error' in shaped) return invalidArgument('module/page', shaped.error);
        return asResult(shaped.output, {
          narrowHint:
            'The data is long: ask for one module at a time with module, or read the pages.',
        });
      } catch (err) {
        return formatError(err);
      }
    },
  );

  // ── get_report_status (read) ──
  server.registerTool(
    'get_report_status',
    {
      title: 'Check a report run',
      description: `Check whether a report started with run_report has finished. Reading is free. A full report takes about 10 to 20 minutes.

POLL NO MORE OFTEN THAN EVERY ${REPORT_STATUS_POLL_SECONDS} SECONDS. Each call is counted against your API allowance and the report cannot finish faster; tell the user it is running and check again later instead of calling in a loop.

Args:
  - report_id (string, required): the report_id from run_report

Returns JSON: { data: { report_id, status, finished, message, ... } }. status: "processing" (still running), "completed", "no_competitors" (finished: a profile of the product alone), or "no_rivals" (stopped before any research because no competitor could be counted as a rival; no credits were used). The API does not report a percentage: status is all there is. When finished is true the result names the next call: get_report with the report_id.

Use when: "is my report ready?" after run_report.`,
      inputSchema: GetReportStatusSchema,
      annotations: READ_ONLY,
    },
    async (args: z.infer<typeof GetReportStatusSchema>) => {
      const nul = nulArgument(args);
      if (nul) return invalidArgument(nul, NUL_MESSAGE);
      try {
        const res = (await client.getReportStatus(args.report_id.trim())) as {
          data?: Record<string, unknown>;
        };
        return asResult({ data: shapeReportStatus(args.report_id.trim(), res.data ?? {}) });
      } catch (err) {
        return formatError(err, 'REPORT_NOT_FOUND');
      }
    },
  );

  // ── add_competitor (WRITE) — registered only when writes are enabled ──
  if (!allowWrites) return;

  // ── set_agent_competitor (WRITE, Agent plans) ──
  server.registerTool(
    'set_agent_competitor',
    {
      title: 'Track a competitor in a slot (Agent plan)',
      description: `Put a competitor into one of your Agent plan's slots, or replace the one in a slot. Costs no credits and starts no analysis: it queues a collection of public data (refreshed at most every 7 days). An Agent plan tracks 3 competitors at once; each slot can be replaced once per calendar month.

Args:
  - url (string, required): the competitor website
  - name (string, optional): display name
  - slot (number 0-2, optional): omitted = the first empty slot; naming a filled slot replaces it and uses that slot's change for the month

Returns JSON: { data: { action: assigned | changed | already_tracked, slot, replaced, collection_queued, slots_used, slots_total } }.
Refusals pass through with their reason: agent_slot_limit (all 3 slots full, name a slot to replace) and agent_slot_change_limit (that slot already changed this month; the message gives the date it resets).

Use when: "track <url> for me", "swap <old> for <new>".`,
      inputSchema: SetAgentCompetitorSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args: z.infer<typeof SetAgentCompetitorSchema>) => {
      const nul = nulArgument(args);
      if (nul) return invalidArgument(nul, NUL_MESSAGE);
      try {
        const res = await client.setAgentCompetitor({
          url: args.url.trim(),
          ...(args.name ? { name: args.name } : {}),
          ...(args.slot !== undefined ? { slot: args.slot } : {}),
        });
        return asResult(res as Record<string, unknown>);
      } catch (err) {
        return formatError(err);
      }
    },
  );

  server.registerTool(
    'add_competitor',
    {
      title: 'Add a competitor',
      description: `Add one or more competitor URLs to a project in your account. This is the two-way write half of the data layer: adding a competitor Rivalize has not seen before ALSO queues a crawl of that company across 8 intelligence layers, which adds it to the Rivalize universe of tracked companies.

Args:
  - project_id (string, required): the project UUID (from list_projects) to add competitors to
  - urls (string[], required): 1-10 competitor URLs

Returns JSON: { data: { competitors_added, competitors_skipped, job_id, message } }.
A non-null job_id means analysis was enqueued; poll get_competitor_intelligence later for results.

This is a WRITE that consumes credits and triggers analysis. Returns 402 if out of credits, 409 if it would exceed the plan's competitor limit, 404 if the project is not yours.

Use when: "add <url> as a competitor to my <project>".`,
      inputSchema: AddCompetitorSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args: z.infer<typeof AddCompetitorSchema>) => {
      const nul = nulArgument(args);
      if (nul) return invalidArgument(nul, NUL_MESSAGE);
      try {
        const res = await client.addCompetitor(args.project_id, args.urls);
        return asResult(res as Record<string, unknown>);
      } catch (err) {
        return formatError(err, 'PROJECT_NOT_FOUND');
      }
    },
  );

  // ── run_report (WRITE): starts a REAL report ──
  server.registerTool(
    'run_report',
    {
      title: 'Run a report (uses credits)',
      description: `Start a real competitive-intelligence report for one of your projects. THIS USES YOUR CREDITS and your monthly report allowance, and takes about 10 to 20 minutes. Paid dashboard plans only: free and Agent plan keys are refused by the API, and the refusal is passed through as it is.

TWO STEPS. Never start a report the user has not agreed to.
  1. Call run_report WITHOUT confirm. Nothing is started or charged. It returns a PREVIEW: the depth, the project and the competitors that would be analysed, the credits it will use, the credits and monthly reports you have left, and the expected time. Show the user all of it and ask.
  2. Only when the user agrees, call run_report again with the same arguments and confirm: true. That starts the report and uses the credits.

Args:
  - project_id (string, required): the project UUID from list_projects; its product and active competitors are analysed
  - depth (string, optional): "full" (default; full research, 15 credits per 5 competitors, uses one of the monthly reports) or "quick" (public pages only, 1 credit per competitor, does not use a monthly report)
  - confirm (boolean, optional): true starts the report. Omit it for the preview.

Returns JSON: { data: { started, report_id, ... } }. The preview has started: false, credits { to_use, remaining, remaining_after }, monthly_report_allowance, api_runs_today and expected_duration. A started run has started: true and a report_id: check it with get_report_status (no more often than every ${REPORT_STATUS_POLL_SECONDS} seconds), then read it with get_report.
Limits: each account can start a limited number of reports per UTC day through the API or MCP (dashboard runs are not counted). The preview's api_runs_today gives the limit and what is left; a started run returns api_runs_today and, when few are left, a warning sentence: show it to the user. A refusal names the limit and when it resets. Asking again for the same project, competitors and depth within 10 minutes returns the run already started (already_started: true) and charges nothing more.
Refusals pass through with their code: PLAN_REQUIRED, agent_model_work_not_in_plan, INSUFFICIENT_CREDITS, REPORT_LIMIT_REACHED, PLAN_COMPETITOR_LIMIT, API_REPORT_RUN_LIMIT (the message gives when it resets).

Use when: "run a fresh report on <project>", after the user has seen the preview and said yes.`,
      inputSchema: RunReportSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args: z.infer<typeof RunReportSchema>) => {
      const nul = nulArgument(args);
      if (nul) return invalidArgument(nul, NUL_MESSAGE);
      const depth = args.depth ?? 'full';
      const projectId = args.project_id.trim();
      try {
        const project = ((await client.getProject(projectId)) as { data?: ProjectForRun }).data;
        const productUrl = project?.url?.trim();
        if (!productUrl) {
          return {
            content: [
              {
                type: 'text',
                text: `Error: project ${quoteInput(projectId)} has no product URL, so a report cannot be run for it. Nothing was started or charged. Add the product URL in the Rivalize dashboard.`,
              },
            ],
            isError: true,
          };
        }
        const rivals = (project?.competitors ?? []).filter(
          (c) => c.is_active !== false && typeof c.website === 'string' && c.website.trim() !== '',
        );
        const competitorUrls = rivals.map((c) => (c.website as string).trim());
        const nameOf = (url: string) =>
          rivals.find((c) => (c.website as string).trim() === url)?.name ?? null;
        const confirmed = args.confirm === true;

        // ONLY `confirm: true` reaches the route that starts a report; anything
        // else (absent, false, any other value) asks the preview route.
        const body = { product_url: productUrl, competitor_urls: competitorUrls, depth };
        const res = (await (confirmed ? client.runReport(body) : client.previewReport(body))) as {
          data?: Record<string, unknown>;
        };
        const d = res.data ?? {};
        const analysed = Array.isArray(d.competitor_urls) ? (d.competitor_urls as string[]) : [];
        const competitors = analysed.map((url) => ({ name: nameOf(url), website: url }));
        const projectOut = { id: projectId, name: project?.name ?? null, url: productUrl };

        if (confirmed) {
          const reportId = String(d.job_id ?? '');
          const already = d.already_started === true;
          return asResult({
            data: {
              started: true,
              already_started: already,
              report_id: reportId,
              status_url: d.status_url,
              depth,
              project: projectOut,
              competitors,
              dropped: d.dropped ?? [],
              message: d.message,
              api_runs_today: d.api_runs_today ?? null,
              warning: d.warning ?? null,
              next: `Check it with ${callText('get_report_status', { report_id: reportId })}, no more often than every ${REPORT_STATUS_POLL_SECONDS} seconds; a full report takes about 10 to 20 minutes. Then read it with get_report.`,
            },
          });
        }

        const dup = d.already_started as { job_id?: string } | null | undefined;
        return asResult({
          data: {
            started: false,
            preview: true,
            project: projectOut,
            depth: d.depth ?? depth,
            competitors,
            ...(competitors.length === 0
              ? {
                  note: 'This project has no active competitors, so the report profiles the product alone, with no comparison.',
                }
              : {}),
            dropped: d.dropped ?? [],
            credits: d.credits,
            monthly_report_allowance: d.monthly_report_allowance,
            api_runs_today: d.api_runs_today,
            expected_duration: d.expected_duration,
            already_started: dup ?? null,
            message: dup?.job_id
              ? `NOTHING WAS STARTED. The same report was started less than 10 minutes ago (report_id ${dup.job_id}); confirming returns that run and charges nothing more. Check it with get_report_status.`
              : 'NOTHING WAS STARTED OR CHARGED. Show this preview to the user. Only if they agree, call run_report again with the same arguments and confirm: true.',
            to_start: callText('run_report', { project_id: projectId, depth, confirm: true }),
          },
        });
      } catch (err) {
        return formatError(err, 'PROJECT_NOT_FOUND');
      }
    },
  );
}

/** Read tools — always registered. Used by tests and docs. */
export const READ_TOOL_NAMES = [
  'list_universe_companies',
  'get_universe_company',
  'teardown_competitor',
  'list_projects',
  'list_reports',
  'get_report',
  'list_competitors',
  'get_competitor_intelligence',
  'get_competitor_posts',
  'rank_competitor_accounts',
  'get_battlecard',
  'get_strategic_timeline',
  'get_competitive_landscape',
  'get_freshness',
  'get_evidence',
  'get_report_status',
] as const;

/** Write tools — registered only with RIVALIZE_MCP_ALLOW_WRITES. */
export const WRITE_TOOL_NAMES = ['add_competitor', 'run_report'] as const;

/**
 * Agent plan tools. The reads are always registered (a dashboard plan that
 * calls one gets the API's 403 agent_plan_required, which the tool passes through);
 * the slot write is gated like add_competitor.
 */
export const AGENT_READ_TOOL_NAMES = ['list_agent_competitors', 'get_agent_competitor'] as const;
export const AGENT_WRITE_TOOL_NAMES = ['set_agent_competitor'] as const;

/** Every tool this server can register. */
export const TOOL_NAMES = [
  ...READ_TOOL_NAMES,
  ...AGENT_READ_TOOL_NAMES,
  ...WRITE_TOOL_NAMES,
  ...AGENT_WRITE_TOOL_NAMES,
] as const;
