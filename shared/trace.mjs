import fs from 'node:fs';
import path from 'node:path';

const MAX = 2000;
const SUFFIX = '…[truncated]';

function clip(v, seen) {
  if (typeof v === 'string') return v.length > MAX ? v.slice(0, MAX) + SUFFIX : v;
  if (v === null || typeof v !== 'object') return v;
  if (seen.has(v)) throw new Error('circular');
  seen.add(v);
  const out = Array.isArray(v) ? v.map((x) => clip(x, seen)) : {};
  if (!Array.isArray(v)) for (const k of Object.keys(v)) out[k] = clip(v[k], seen);
  seen.delete(v);
  return out;
}

// Appends one JSON line to <stateDir>/trace.jsonl when PROBE_RECORD is set.
// Never throws; any failure (circular, non-JSON, unwritable) skips logging.
export function trace(stateDir, entry) {
  try {
    if (!process.env.PROBE_RECORD) return;
    const seen = new WeakSet();
    const line = JSON.stringify({
      at: new Date().toISOString(),
      host: entry.host,
      hook: entry.hook,
      sessionId: entry.sessionId,
      input: clip(entry.input, seen),
      decision: clip(entry.decision, seen),
    });
    fs.mkdirSync(stateDir, { recursive: true });
    fs.appendFileSync(path.join(stateDir, 'trace.jsonl'), line + '\n');
  } catch {}
}
