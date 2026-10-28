/**
 * EU AI Act Article 50: every tool result says it is AI-generated.
 *
 * The same marker, with the same four strings, is used across Rivalize's API,
 * exports and dashboard, so an assistant and a person see one wording.
 *
 * What a result carries:
 *   - JSON text results:  a top-level `ai_generated: true` and `ai_disclosure`
 *     in the JSON, and in `structuredContent` when the tool returns it;
 *   - Markdown/plain text results: a second content block with the disclosure;
 *   - every result: `_meta.ai_generated = true`.
 * Errors are not content and are left alone.
 */

export const AI_GENERATED_MARKER_NAME = 'ai_generated';
export const AI_GENERATED_LINE = 'AI-generated, sources cited';
export const AI_DISCLOSURE_FIELD = 'ai_disclosure';
export const AI_CHAT_DISCLOSURE =
  'You are chatting with an AI. Answers are AI-generated and can be wrong: check the cited sources.';

/** What an MCP client's user reads: the line and the Art 50(1) sentence. */
export const MCP_DISCLOSURE_TEXT = `${AI_GENERATED_LINE}. ${AI_CHAT_DISCLOSURE}`;

interface ToolResultLike {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

/** The disclosure fields as JSON text, without braces, for splicing into a serialised object. */
function jsonFields(): string {
  return `"${AI_GENERATED_MARKER_NAME}":true,"${AI_DISCLOSURE_FIELD}":${JSON.stringify(AI_CHAT_DISCLOSURE)}`;
}

/** Splice the fields into a serialised JSON object; null when the text is not one. */
function spliceJsonObject(text: string): string | null {
  const start = text.search(/\S/);
  if (start < 0 || text[start] !== '{') return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  } catch {
    return null;
  }
  if (new RegExp(`^\\{\\s*"${AI_GENERATED_MARKER_NAME}"\\s*:`).test(text.slice(start))) return text;
  const rest = text.slice(start + 1);
  const empty = /^\s*\}/.test(rest);
  return `${text.slice(0, start + 1)}${jsonFields()}${empty ? '' : ','}${rest}`;
}

/** A tool result, marked. An error result is returned as it is. */
export function markToolResult<T extends ToolResultLike>(result: T): T {
  if (result.isError) return result;
  const first = result.content[0];
  const spliced = first ? spliceJsonObject(first.text) : null;
  const content =
    spliced !== null
      ? [{ ...first, text: spliced }, ...result.content.slice(1)]
      : [...result.content, { type: 'text' as const, text: MCP_DISCLOSURE_TEXT }];
  const structured = result.structuredContent
    ? {
        [AI_GENERATED_MARKER_NAME]: true,
        [AI_DISCLOSURE_FIELD]: AI_CHAT_DISCLOSURE,
        ...result.structuredContent,
      }
    : undefined;
  return {
    ...result,
    content,
    ...(structured ? { structuredContent: structured } : {}),
    _meta: { ...result._meta, [AI_GENERATED_MARKER_NAME]: true },
  };
}
