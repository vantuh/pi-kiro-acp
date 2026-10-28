/** Strips the `[STEERING <id>: …]` note V3 models append to their answer after
 * a native steer (16 of 18 probe answers). Streaming-safe: text is held only
 * from a `[` that may still become the marker, so a chunk is never cut twice
 * and nothing is dropped unless its id is a steer this session queued. */

const MARKER = '[STEERING ';
const ID_RE = /^\[STEERING ([^\s:\]]+)/;
const TRAILING_SPACE_RE = /[ \t\r\n]+$/;

export interface SteerEchoFilter {
  /** Text to emit now; anything undecided stays held. */
  push(text: string): string;
  /** Everything still held — call when the text block or the turn ends. */
  flush(): string;
}

/** `steerIds` is read on every push, so ids recorded mid-turn are honoured.
 * A session with no recorded id pays nothing: nothing is ever held. */
export function createSteerEchoFilter(
  steerIds: () => Iterable<string>,
): SteerEchoFilter {
  let held = '';

  const drain = (final: boolean): string => {
    const ids = new Set(steerIds());
    if (!final && ids.size === 0) {
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
      const close = buffer.indexOf(']');
      if (close < 0) {
        // The marker is real but the note is not complete.
        if (!final) break;
        out += buffer;
        buffer = '';
        break;
      }
      const block = buffer.slice(0, close + 1);
      const id = ID_RE.exec(block)?.[1];
      buffer = buffer.slice(close + 1);
      if (id && ids.has(id)) {
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
