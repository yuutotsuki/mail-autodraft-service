import fs from 'fs';
import path from 'path';
import { extractFirstEmail } from '../utils/text';

export type RuleHit = { rule_id: string; weight: number };

export type DetectResult = {
  label: 'compose' | 'reply' | 'other';
  compose_score: number;
  reply_score: number;
  rule_hits: RuleHit[];
};

type TriggerRule = { rule_id: string; weight: number; phrases: string[] };
type MarkerGroup = { rule_id: string; weight: number; terms: string[] }[];
type RegexRule = { rule_id: string; weight: number; target: 'compose' | 'reply' | 'gen'; pattern: string; flags?: string };
type BlockRule = { rule_id: string; weight: number; block: boolean; phrases: string[] };

type ParsedConfig = {
  compose_min: number;
  reply_min: number;
  triggers: TriggerRule[];
  reply_triggers: TriggerRule[];
  markers: { to: MarkerGroup; subject: MarkerGroup; body: MarkerGroup };
  regexes: RegexRule[];
  blockers: BlockRule[];
};

function safeRead(file: string): string {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function parseInlineArray(line: string): string[] {
  const m = line.match(/\[(.*)\]/);
  if (!m) return [];
  return m[1]
    .split(',')
    .map((s) => s.replace(/^\s*"|\s*"$/g, '').trim())
    .map((s) => s.replace(/^"|"$/g, ''))
    .filter(Boolean);
}

function parseComposeYaml(text: string): ParsedConfig {
  const lines = text.split(/\r?\n/);
  let section: 'none' | 'triggers' | 'reply_triggers' | 'to_markers' | 'subject_markers' | 'body_markers' | 'regexes' | 'blockers' = 'none';
  const triggers: TriggerRule[] = [];
  const replyTriggers: TriggerRule[] = [];
  const toMarkers: MarkerGroup = [];
  const subjectMarkers: MarkerGroup = [];
  const bodyMarkers: MarkerGroup = [];
  const regexes: RegexRule[] = [];
  const blockers: BlockRule[] = [];
  let compose_min = 2.0;
  let reply_min = 2.0;

  let cur: any = null;

  for (let raw of lines) {
    const line = raw.trim();
    if (line.startsWith('#') || line.length === 0) continue;
    if (line.startsWith('compose_min_score:')) {
      const n = Number(line.split(':')[1]);
      if (!Number.isNaN(n)) compose_min = n;
      continue;
    }
    if (line.startsWith('reply_min_score:')) {
      const n = Number(line.split(':')[1]);
      if (!Number.isNaN(n)) reply_min = n;
      continue;
    }
    if (line === 'triggers:' ) { section = 'triggers'; cur = null; continue; }
    if (line === 'reply_triggers:' ) { section = 'reply_triggers'; cur = null; continue; }
    if (line === 'regexes:' ) { section = 'regexes'; cur = null; continue; }
    if (line === 'blockers:' ) { section = 'blockers'; cur = null; continue; }
    if (line === 'markers:' ) { section = 'none'; cur = null; continue; }
    if (line === 'to_markers:' ) { section = 'to_markers'; cur = null; continue; }
    if (line === 'subject_markers:' ) { section = 'subject_markers'; cur = null; continue; }
    if (line === 'body_markers:' ) { section = 'body_markers'; cur = null; continue; }

    if (line.startsWith('- rule_id:')) {
      if (section === 'triggers' || section === 'reply_triggers') {
        cur = { rule_id: line.split(':')[1].trim(), weight: 0, phrases: [] };
        (section === 'triggers' ? triggers : replyTriggers).push(cur);
        continue;
      }
      if (section === 'to_markers' || section === 'subject_markers' || section === 'body_markers') {
        cur = { rule_id: line.split(':')[1].trim(), weight: 0, terms: [] };
        (section === 'to_markers' ? toMarkers : section === 'subject_markers' ? subjectMarkers : bodyMarkers).push(cur);
        continue;
      }
      if (section === 'regexes') {
        cur = { rule_id: line.split(':')[1].trim(), weight: 0, target: 'gen', pattern: '', flags: '' };
        regexes.push(cur);
        continue;
      }
      if (section === 'blockers') {
        cur = { rule_id: line.split(':')[1].trim(), weight: 0, block: false, phrases: [] };
        blockers.push(cur);
        continue;
      }
    }
    if (cur) {
      if (/^weight:/.test(line)) {
        const n = Number(line.split(':')[1]);
        if (!Number.isNaN(n)) cur.weight = n;
        continue;
      }
      if (/^phrases:/.test(line)) {
        cur.phrases = parseInlineArray(line);
        continue;
      }
      if (/^terms:/.test(line)) {
        cur.terms = parseInlineArray(line);
        continue;
      }
      if (/^pattern:/.test(line)) {
        const m = line.match(/pattern:\s*"(.*)"/);
        cur.pattern = m?.[1] || '';
        continue;
      }
      if (/^flags:/.test(line)) {
        const m = line.match(/flags:\s*"(.*)"/);
        cur.flags = m?.[1] || '';
        continue;
      }
      if (/^target:/.test(line)) {
        const m = line.match(/target:\s*(\w+)/);
        const t = (m?.[1] || '').toLowerCase();
        cur.target = (t === 'compose' || t === 'reply') ? t : 'gen';
        continue;
      }
      if (/^block:/.test(line)) {
        cur.block = /true/i.test(line.split(':')[1]);
        continue;
      }
    }
  }

  return {
    compose_min,
    reply_min,
    triggers,
    reply_triggers: replyTriggers,
    markers: { to: toMarkers, subject: subjectMarkers, body: bodyMarkers },
    regexes,
    blockers,
  };
}

let cachedCfg: ParsedConfig | null = null;

function getConfig(): ParsedConfig {
  if (cachedCfg) return cachedCfg;
  const base = path.resolve(__dirname, '..');
  const file = path.resolve(base, 'config', 'compose_detection.yaml');
  const txt = safeRead(file);
  cachedCfg = parseComposeYaml(txt);
  return cachedCfg;
}

function containsAny(text: string, arr: string[]): boolean {
  const s = text.toLowerCase();
  return arr.some((t) => s.includes(String(t || '').toLowerCase()));
}

export function detectComposeOrReply(text: string, context?: { in_thread?: boolean }): DetectResult {
  const cfg = getConfig();
  const hits: RuleHit[] = [];
  let s = text || '';
  // Improve regex hit-rate for Slack <mailto:...|...> by appending plain email token
  const email = extractFirstEmail(s);
  if (email && !s.includes(email)) {
    s = `${s} ${email}`;
  }

  // blockers first
  for (const b of cfg.blockers) {
    if (containsAny(s, b.phrases)) {
      hits.push({ rule_id: b.rule_id, weight: b.weight });
    }
  }

  let compose = 0;
  let reply = 0;

  for (const r of cfg.triggers) {
    if (containsAny(s, r.phrases)) { compose += r.weight; hits.push({ rule_id: r.rule_id, weight: r.weight }); }
  }
  for (const r of cfg.reply_triggers) {
    if (containsAny(s, r.phrases)) { reply += r.weight; hits.push({ rule_id: r.rule_id, weight: r.weight }); }
  }

  const markerGroups: Array<{ list: MarkerGroup; target: 'compose' | 'reply'; }> = [
    { list: cfg.markers.to, target: 'compose' },
    { list: cfg.markers.subject, target: 'compose' },
    { list: cfg.markers.body, target: 'compose' },
  ];
  for (const g of markerGroups) {
    for (const r of g.list) {
      if (containsAny(s, r.terms)) {
        if (g.target === 'compose') compose += r.weight; else reply += r.weight;
        hits.push({ rule_id: r.rule_id, weight: r.weight });
      }
    }
  }

  // regexes
  for (const rx of cfg.regexes) {
    if (!rx.pattern) continue;
    try {
      const re = new RegExp(rx.pattern, rx.flags || undefined);
      if (re.test(s)) {
        if (rx.target === 'reply') reply += rx.weight; else compose += rx.weight;
        hits.push({ rule_id: rx.rule_id, weight: rx.weight });
      }
    } catch {}
  }

  // context: in_thread -> small reply push if configured in regexes/ctx_signals (not parsed fully here)
  if (context?.in_thread) {
    // lightweight nudge: +0.5 to reply if not already over threshold
    reply += 0.0; // reserved; config has CTX_REPLY_ja_001 in context_signals (not parsed in this minimal pass)
  }

  let label: 'compose' | 'reply' | 'other' = 'other';
  if (compose >= cfg.compose_min && compose >= reply) label = 'compose';
  else if (reply >= cfg.reply_min) label = 'reply';

  return { label, compose_score: compose, reply_score: reply, rule_hits: hits };
}
