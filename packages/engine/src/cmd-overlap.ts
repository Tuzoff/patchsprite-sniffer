// When two cmd templates can be the same bytes: as many tokens, and each token the same byte or a `{placeholder}` on
// either side (a placeholder is filled per call, so it can be any byte). The one copy of the rule: the map's load
// checks (cmdsOverlap) and the seed patch's blocked-message index (BlockedCmds) both use it, and
// packages/engine/vectors/cmd-overlap.json pins it for both.

const isPlaceholder = (t: string) => t.startsWith("{");

/** A cmd's tokens: lower-case hex pairs and `{placeholders}`, as a map spells it (hex is matched without case). */
const tokens = (cmd: string): string[] => cmd.split(" ").map((t) => (isPlaceholder(t) ? t : t.toLowerCase()));

/** Whether two tokens can be the same byte. */
const tokensMeet = (a: string, b: string) => isPlaceholder(a) || isPlaceholder(b) || a === b;

/** Whether `x` can be the bytes `y` begins with: no longer, and each of its tokens meets `y`'s. */
export function tokensBegin(x: readonly string[], y: readonly string[]): boolean {
  return x.length <= y.length && x.every((t, i) => tokensMeet(t, y[i]));
}

/** Whether two cmd templates can produce the same bytes. */
export function cmdsOverlap(a: string, b: string): boolean {
  const x = tokens(a);
  const y = tokens(b);
  return x.length === y.length && tokensBegin(x, y);
}

/** The longest cmd a map can load, in tokens (`transport.inner.cmdLength`). A longer one is judged by nothing. */
export const MAX_CMD_TOKENS = 8;

/** A cmd's tokens and which of them are placeholders, as bits; null past the longest cmd a map can load. */
function parseCmd(cmd: string): { toks: string[]; mask: number } | null {
  const toks = tokens(cmd);
  if (toks.length > MAX_CMD_TOKENS) return null;
  return { toks, mask: toks.reduce((m, t, i) => (isPlaceholder(t) ? m | (1 << i) : m), 0) };
}

const maskedKey = (toks: readonly string[], mask: number) => toks.map((t, i) => (mask & (1 << i) ? "*" : t)).join(" ");

/**
 * A set of cmds, for asking whether a cmd overlaps any of them by cmdsOverlap's rule. They are grouped by length and
 * placeholder positions, so a lookup costs a Set probe per group rather than a compare per cmd. A cmd past the longest
 * a map can load can't load, so it overlaps everything (whether added or asked about).
 */
export class BlockedCmds {
  private readonly groups = new Map<number, Map<number, string[][]>>();
  private readonly keyed = new Map<string, Set<string>>();
  private all = false;
  add(cmd: string): void {
    const c = parseCmd(cmd);
    if (!c) return void (this.all = true);
    this.keyed.clear();
    let byMask = this.groups.get(c.toks.length);
    if (!byMask) this.groups.set(c.toks.length, (byMask = new Map()));
    const list = byMask.get(c.mask);
    if (list) list.push(c.toks);
    else byMask.set(c.mask, [c.toks]);
  }
  hits(cmd: string): boolean {
    const c = parseCmd(cmd);
    if (!c || this.all) return true;
    for (const [mask, list] of this.groups.get(c.toks.length) ?? []) {
      const both = mask | c.mask;
      const id = `${c.toks.length}/${mask}/${both}`;
      let keys = this.keyed.get(id);
      if (!keys) this.keyed.set(id, (keys = new Set(list.map((t) => maskedKey(t, both)))));
      if (keys.has(maskedKey(c.toks, both))) return true;
    }
    return false;
  }
}
