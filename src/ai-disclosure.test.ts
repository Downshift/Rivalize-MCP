/**
 * EU AI Act Article 50: every MCP tool result says it is AI-generated.
 *
 * Runs the REAL McpServer from buildServer() against a REAL MCP Client over an
 * in-memory transport (the fetch is mocked: no metered call). The disclosure is
 * asserted on what the client receives for EVERY read tool, so a tool added
 * tomorrow that bypasses the wrapper fails here.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import {
  AI_CHAT_DISCLOSURE,
  AI_DISCLOSURE_FIELD,
  AI_GENERATED_LINE,
  AI_GENERATED_MARKER_NAME,
  MCP_DISCLOSURE_TEXT,
  markToolResult,
} from './ai-disclosure.js';
import { RivalizeClient } from './client.js';
import { buildServer } from './index.js';
import { READ_TOOL_NAMES } from './tools.js';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function routedFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/v1/reports/') && url.includes('/intelligence'))
      return json(200, { data: { id: 'r-1', markdown: '# Report\n\nThey lead.', sections: [] } });
    if (url.includes('/v1/projects')) return json(200, { data: [{ id: 'p-1', name: 'P' }] });
    return json(200, { data: [{ id: 'x', name: 'X' }] });
  }) as unknown as typeof fetch;
}

async function connect() {
  const server = buildServer(
    new RivalizeClient({ apiKey: 'rk_live_x', apiUrl: 'https://api.test.invalid' }, routedFetch()),
  );
  const client = new Client({ name: 'ai-disclosure-test', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe('over a real MCP client', () => {
  it('list_projects: the JSON text carries ai_generated and ai_disclosure; _meta carries the marker', async () => {
    const { client, close } = await connect();
    try {
      const res = await client.callTool({ name: 'list_projects', arguments: {} });
      expect(res.isError).toBeFalsy();
      const content = res.content as Array<{ type: string; text: string }>;
      const body = JSON.parse(content[0].text);
      expect(body[AI_GENERATED_MARKER_NAME]).toBe(true);
      expect(body[AI_DISCLOSURE_FIELD]).toBe(AI_CHAT_DISCLOSURE);
      expect(body.data).toBeDefined();
      expect(res._meta?.[AI_GENERATED_MARKER_NAME]).toBe(true);
    } finally {
      await close();
    }
  });

  it('get_report (Markdown): a second content block carries the disclosure and the first is untouched', async () => {
    const { client, close } = await connect();
    try {
      const res = await client.callTool({ name: 'get_report', arguments: { report_id: 'r-1' } });
      const content = res.content as Array<{ type: string; text: string }>;
      expect(content[0].text).toContain('# Report');
      expect(content[content.length - 1].text).toBe(MCP_DISCLOSURE_TEXT);
      expect(MCP_DISCLOSURE_TEXT).toContain(AI_GENERATED_LINE);
      expect(res._meta?.[AI_GENERATED_MARKER_NAME]).toBe(true);
    } finally {
      await close();
    }
  });

  it('every read tool that returns content is marked (none bypasses the wrapper)', async () => {
    const { client, close } = await connect();
    try {
      const unmarked: string[] = [];
      for (const name of READ_TOOL_NAMES) {
        const res = await client.callTool({ name, arguments: {} });
        if (res.isError) continue; // an error is not content; it is left alone
        const text = (res.content as Array<{ text: string }>).map((c) => c.text).join('\n');
        const marked =
          res._meta?.[AI_GENERATED_MARKER_NAME] === true &&
          (text.includes(`"${AI_GENERATED_MARKER_NAME}":true`) ||
            text.includes(MCP_DISCLOSURE_TEXT));
        if (!marked) unmarked.push(name);
      }
      expect(unmarked).toEqual([]);
      // Non-vacuity: the loop reached tools (an all-error run would pass the check above).
      expect(READ_TOOL_NAMES.length).toBeGreaterThanOrEqual(10);
    } finally {
      await close();
    }
  });
});

describe('markToolResult', () => {
  it('leaves an error result alone', () => {
    const err = { content: [{ type: 'text' as const, text: 'Error: nope' }], isError: true };
    expect(markToolResult(err)).toBe(err);
  });

  it('marks structuredContent too, and puts the marker first', () => {
    const out = markToolResult({
      content: [{ type: 'text' as const, text: '{"data":[]}' }],
      structuredContent: { data: [] },
    });
    expect(Object.keys(out.structuredContent ?? {})).toEqual([
      AI_GENERATED_MARKER_NAME,
      AI_DISCLOSURE_FIELD,
      'data',
    ]);
  });

  it('is idempotent on JSON text', () => {
    const once = markToolResult({ content: [{ type: 'text' as const, text: '{"a":1}' }] });
    const twice = markToolResult(once);
    expect(twice.content[0].text).toBe(once.content[0].text);
  });
});

describe('the wording is pinned', () => {
  it('uses the same marker name, visible line, field name and chat disclosure everywhere', () => {
    expect(AI_GENERATED_MARKER_NAME).toBe('ai_generated');
    expect(AI_GENERATED_LINE).toBe('AI-generated, sources cited');
    expect(AI_DISCLOSURE_FIELD).toBe('ai_disclosure');
    expect(AI_CHAT_DISCLOSURE).toBe(
      'You are chatting with an AI. Answers are AI-generated and can be wrong: check the cited sources.',
    );
    expect(MCP_DISCLOSURE_TEXT).toBe(`${AI_GENERATED_LINE}. ${AI_CHAT_DISCLOSURE}`);
  });
});
