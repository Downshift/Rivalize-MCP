/**
 * Reading a big competitor through get_agent_competitor.
 *
 * The `core` group of a large site (website pages with their text, the pricing
 * pages) is far over the 25,000-character tool limit, and the old tool applied
 * its `group` filter and then let fitJson drop the whole `groups` field: the
 * customer could not read the website or pricing text at all.
 *
 * Here the requested modules are read in PAGES. Nothing is dropped and nothing is
 * cut without saying so:
 *   - `module` narrows to one module (website, pricing, ...), in `group` or any.
 *   - When the narrowed data still does not fit, it is split into parts: a whole
 *     module when it fits, else the module's largest array item by item (the
 *     crawl's pages), else a long string in consecutive chunks. Parts are packed
 *     into pages that each fit the limit; `_page` says "page N of M" and the exact
 *     next call; `contents` lists every module and the pages it spans.
 *   - Data that fits is returned in the original shape, unpaged.
 */

import { CHARACTER_LIMIT } from './markdown-pages.js';

type Dict = Record<string, unknown>;

export interface AgentReadArgs {
  competitor_id: string;
  group?: string;
  module?: string;
  page?: number;
}

const isDict = (v: unknown): v is Dict => typeof v === 'object' && v !== null && !Array.isArray(v);
const size = (v: unknown) => JSON.stringify(v).length;

/** Room kept for the page header, `contents` and JSON string escaping of a chunk. */
const SLACK = 4_500;

interface Part {
  group: string;
  module: string;
  status?: unknown;
  source?: unknown;
  collected_at?: unknown;
  error?: unknown;
  data: unknown;
  /** Present when `data` is a slice of the module's data. */
  partial?: Dict;
}

function sliceString(s: string, max: number): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    let end = Math.min(s.length, i + max);
    // never cut between the halves of a surrogate pair
    if (end < s.length) {
      const c = s.charCodeAt(end - 1);
      if (c >= 0xd800 && c <= 0xdbff) end -= 1;
    }
    out.push(s.slice(i, end));
    i = end;
  }
  return out;
}

function largestKey(d: Dict, pick: (v: unknown) => boolean): string | null {
  let best: string | null = null;
  let bestSize = -1;
  for (const [k, v] of Object.entries(d)) {
    if (!pick(v)) continue;
    const s = size(v);
    if (s > bestSize) {
      best = k;
      bestSize = s;
    }
  }
  return best;
}

/** Split one module entry's `data` into slices that each fit `budget` characters. */
function splitData(
  data: unknown,
  budget: number,
  base: Omit<Part, 'data' | 'partial'>,
): Array<Pick<Part, 'data' | 'partial'>> {
  const fits = (d: unknown, partial?: Dict) => size({ ...base, data: d, partial }) <= budget;
  if (fits(data)) return [{ data }];
  if (!isDict(data)) {
    if (typeof data === 'string') {
      return sliceString(data, Math.max(1_000, budget - 600)).map((c, i, all) => ({
        data: c,
        partial: { chunk: i + 1, chunks: all.length },
      }));
    }
    return [{ data }];
  }

  const out: Array<Pick<Part, 'data' | 'partial'>> = [];
  const arrayKey = largestKey(data, (v) => Array.isArray(v) && v.length > 0);
  const { [arrayKey ?? '']: arr, ...head } = data;

  // everything except the big array: whole if it fits, else key by key
  if (Object.keys(head).length > 0) {
    if (fits(head, { rest_of: arrayKey ?? 'data' })) {
      out.push({ data: head, partial: { rest_of: arrayKey ?? 'data' } });
    } else {
      for (const [k, v] of Object.entries(head)) {
        if (fits({ [k]: v }, { field: k })) {
          out.push({ data: { [k]: v }, partial: { field: k } });
        } else if (typeof v === 'string') {
          const chunks = sliceString(v, Math.max(1_000, budget - 700));
          chunks.forEach((c, i) =>
            out.push({
              data: { [k]: c },
              partial: { field: k, chunk: i + 1, chunks: chunks.length },
            }),
          );
        } else {
          out.push({ data: { [k]: v }, partial: { field: k } });
        }
      }
    }
  }

  if (arrayKey !== null && Array.isArray(arr)) {
    arr.forEach((item, idx) => {
      const partial = { field: arrayKey, item: idx + 1, of: arr.length };
      if (fits({ [arrayKey]: [item] }, partial)) {
        out.push({ data: { [arrayKey]: [item] }, partial });
        return;
      }
      // one item is too big: its longest string goes out in consecutive chunks
      if (isDict(item)) {
        const strKey = largestKey(item, (v) => typeof v === 'string');
        if (strKey !== null) {
          const { [strKey]: long, ...others } = item;
          const room = Math.max(
            1_000,
            budget - size({ ...base, data: { [arrayKey]: [others] }, partial }) - 400,
          );
          const chunks = sliceString(String(long), room);
          chunks.forEach((c, i) =>
            out.push({
              data: { [arrayKey]: [{ ...others, [strKey]: c }] },
              partial: { ...partial, string_field: strKey, chunk: i + 1, chunks: chunks.length },
            }),
          );
          return;
        }
      }
      out.push({ data: { [arrayKey]: [item] }, partial });
    });
  }
  return out;
}

export type AgentReadResult = { output: Dict } | { error: string };

/** The `get_agent_competitor` answer for these arguments: whole when it fits, else one page of it. */
export function shapeAgentRead(
  res: Dict,
  args: AgentReadArgs,
  limit: number = CHARACTER_LIMIT,
): AgentReadResult {
  const data = isDict(res.data) ? res.data : undefined;
  const groupsIn = data && isDict(data.groups) ? data.groups : undefined;
  if (!(data && groupsIn)) return { output: res };

  // 1. narrow to the requested group / module
  const groups: Dict = {};
  const wantedGroups = args.group ? [args.group] : Object.keys(groupsIn);
  const available: string[] = [];
  for (const g of wantedGroups) {
    const grp = groupsIn[g];
    if (!isDict(grp)) continue;
    const modules = isDict(grp.modules) ? grp.modules : {};
    for (const id of Object.keys(modules)) available.push(id);
    if (!args.module) {
      groups[g] = grp;
      continue;
    }
    if (id_in(modules, args.module)) {
      groups[g] = { ...grp, modules: { [args.module]: modules[args.module] } };
    }
  }
  if (args.module && Object.keys(groups).length === 0) {
    return {
      error: `module "${args.module}" is not in ${args.group ? `group ${args.group}` : 'the collected data'}. Modules available: ${available.join(', ') || 'none'}`,
    };
  }

  const narrowed: Dict = { ...res, data: { ...data, groups } };
  if (size(narrowed) <= limit) {
    if (args.page !== undefined && args.page !== 1) {
      return { error: `page ${args.page} does not exist: this read is 1 page` };
    }
    return { output: narrowed };
  }

  // 2. too big: split into parts and pack pages
  const { groups: _g, ...dataRest } = data;
  const envelope: Dict = { ...res, data: { ...dataRest, groups: {} } };
  const partBudget = Math.max(2_000, limit - size(envelope) - SLACK);
  const parts: Part[] = [];
  for (const [g, grp] of Object.entries(groups)) {
    const modules = isDict(grp) && isDict(grp.modules) ? grp.modules : {};
    for (const [m, entryRaw] of Object.entries(modules)) {
      const entry = isDict(entryRaw) ? entryRaw : { data: entryRaw };
      const { data: moduleData, ...meta } = entry;
      const base = { group: g, module: m, ...meta };
      for (const piece of splitData(moduleData, partBudget, base)) {
        parts.push({ ...base, ...piece });
      }
    }
  }

  const pages: Part[][] = [];
  let cur: Part[] = [];
  let curSize = 0;
  for (const part of parts) {
    const s = size(part) + 1;
    if (cur.length > 0 && curSize + s > partBudget) {
      pages.push(cur);
      cur = [];
      curSize = 0;
    }
    cur.push(part);
    curSize += s;
  }
  if (cur.length > 0) pages.push(cur);

  const total = pages.length;
  const page = args.page ?? 1;
  if (!Number.isInteger(page) || page < 1 || page > total) {
    return { error: `page ${page} does not exist: this read has ${total} pages (1-${total})` };
  }

  const contents: Array<{ group: string; module: string; status: unknown; pages: number[] }> = [];
  pages.forEach((ps, i) => {
    for (const p of ps) {
      let c = contents.find((x) => x.group === p.group && x.module === p.module);
      if (!c) {
        c = { group: p.group, module: p.module, status: p.status, pages: [] };
        contents.push(c);
      }
      if (!c.pages.includes(i + 1)) c.pages.push(i + 1);
    }
  });

  const callFor = (n: number) =>
    `get_agent_competitor ${JSON.stringify(
      Object.fromEntries(
        Object.entries({
          competitor_id: args.competitor_id,
          group: args.group,
          module: args.module,
          page: n,
        }).filter(([, v]) => v !== undefined),
      ),
    )}`;
  const next = page < total ? page + 1 : null;
  const output: Dict = {
    ...res,
    data: { ...dataRest, parts: pages[page - 1] },
    _page: {
      page,
      of: total,
      next_page: next,
      ...(next ? { next_call: callFor(next) } : {}),
      message: `Page ${page} of ${total}. The collected data is longer than ${limit} characters, so it is read in pages and nothing is left out: each part names its module and, when a module is split, which item or chunk of it this is (partial). ${next ? `Continue with: ${callFor(next)}.` : 'This is the last page.'} To read one module only, pass module (${contents.map((c) => c.module).join(', ')}).`,
    },
    contents,
  };
  return { output };
}

function id_in(modules: Dict, id: string): boolean {
  return Object.hasOwn(modules, id);
}
