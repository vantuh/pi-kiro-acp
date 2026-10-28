/** Strips the `[STEERING <id>: …]` note V3 models append to their answer after
 * a native steer (16 of 18 probe answers). Streaming-safe: text is held only
 * from a `[` that may still become the marker, so a chunk is never cut twice
 * and nothing is dropped unless its id is a steer this session queued. */

const MARKER = '[STEERING ';
const ID_RE = /^\[STEERING ([^\s:\]]+)/;
const TRAILING_SPACE_RE = /[ \t\r\n]+$/;
/** Release an unterminated marker once this much text is held: keeping it
 * costs a rescan per chunk, and a note that never closes is not ours. */
const MAX_HOLD = 1024;

export interface SteerEchoFilter {
  /** Text to emit now; anything undecided stays held. */
  push(text: string): string;
  /** Everything still held — call when the text block or the turn ends. */
  flush(): string;
}

/** Index of the bracket that closes the note, or -1 while it is still open.
 * Brackets nest, so a `[…]` inside the note does not end it early. */
function noteEnd(buffer: string): number {
  let depth = 0;
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === '[') depth += 1;
    else if (buffer[i] === ']') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function hasAny(ids: Iterable<string>): boolean {
  for (const _ of ids) return true;
  return false;
}

function hasId(ids: Iterable<string>, id: string): boolean {
  for (const candidate of ids) if (candidate === id) return true;
  return false;
}

/** `steerIds` is read on every push, so ids recorded mid-turn are honoured.
 * A session with no recorded id pays nothing: nothing is ever held. */
export function createSteerEchoFilter(
  steerIds: () => Iterable<string>,
): SteerEchoFilter {
  let held = '';

  const drain = (final: boolean): string => {
    const ids = steerIds();
    if (!final && !hasAny(ids)) {
      const rest = held;
      held = '';
      return rest;
    }
    let out = '';
    let buffer = held;
    held = '';
    for (;;) {
      const open = buffer.indexOf('[');
      if (open < 0) {
        out += buffer;
        buffer = '';
        break;
      }
      out += buffer.slice(0, open);
      buffer = buffer.slice(open);
      // `[`, `[S`, … — undecided until more text arrives.
      if (buffer.length < MARKER.length && MARKER.startsWith(buffer)) {
        if (!final) break;
        out += buffer;
        buffer = '';
        break;
      }
      if (!buffer.startsWith(MARKER)) {
        out += buffer[0];
        buffer = buffer.slice(1);
        continue;
      }
      const close = noteEnd(buffer);
      if (close < 0) {
        // An open note. A complete id that is not ours settles it now; anything
        // else is held, and released once the cap says it will never close.
        const openId = ID_RE.exec(buffer)?.[1];
        if (openId && !hasId(ids, openId)) {
          out += buffer;
          buffer = '';
          break;
        }
        if (!final && buffer.length < MAX_HOLD) break;
        out += buffer;
        buffer = '';
        break;
      }
      const block = buffer.slice(0, close + 1);
      const id = ID_RE.exec(block)?.[1];
      buffer = buffer.slice(close + 1);
      if (id && hasId(ids, id)) {
        // The blank lines that introduced the note go with it.
        out = out.replace(TRAILING_SPACE_RE, '');
        continue;
      }
      out += block;
    }
    if (!final) {
      // Trailing whitespace belongs to whatever follows: hold it so an echo
      // that starts on the next chunk still takes it.
      const trailing = TRAILING_SPACE_RE.exec(out);
      if (trailing) {
        buffer = out.slice(trailing.index) + buffer;
        out = out.slice(0, trailing.index);
      }
    }
    held = buffer;
    return out;
  };

  return {
    push(text: string): string {
      held += text;
      return drain(false);
    },
    flush(): string {
      return drain(true);
    },
  };
}
