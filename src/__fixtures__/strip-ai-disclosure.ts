/**
 * Test helper: a tool result as the handler produced it BEFORE the AI
 * disclosure wrapper. The tests that pin a tool's exact payload (one content
 * block, byte-identical Markdown, exact JSON text) drive the handlers through a
 * fake server; this undoes the wrapper's addition so those pins keep testing the
 * tool, and `ai-disclosure.test.ts` tests the addition itself.
 */
import {
  AI_CHAT_DISCLOSURE,
  AI_DISCLOSURE_FIELD,
  AI_GENERATED_MARKER_NAME,
  MCP_DISCLOSURE_TEXT,
} from '../ai-disclosure.js';

const PREFIX = `"${AI_GENERATED_MARKER_NAME}":true,"${AI_DISCLOSURE_FIELD}":${JSON.stringify(AI_CHAT_DISCLOSURE)}`;

interface R {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

export function stripAiDisclosure<T extends R>(res: T): T {
  if (res.isError) return res;
  const content = res.content
    .filter((c) => c.text !== MCP_DISCLOSURE_TEXT)
    .map((c) => {
      if (c.text.indexOf(PREFIX) !== 1 || !c.text.startsWith('{')) return c;
      const rest = c.text.slice(1 + PREFIX.length);
      return { ...c, text: rest.startsWith(',') ? `{${rest.slice(1)}` : `{${rest}` };
    });
  const out: R = { ...res, content };
  if (res.structuredContent) {
    const kept = { ...res.structuredContent };
    delete kept[AI_GENERATED_MARKER_NAME];
    delete kept[AI_DISCLOSURE_FIELD];
    out.structuredContent = kept;
  }
  if (out._meta) {
    const meta = { ...out._meta };
    delete meta[AI_GENERATED_MARKER_NAME];
    if (Object.keys(meta).length) out._meta = meta;
    else delete out._meta;
  }
  return out as T;
}
