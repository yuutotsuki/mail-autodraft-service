import fs from 'fs';
import path from 'path';

type StoreShape = { gmail_list_action?: string };

function storePath(): string {
  const base = path.resolve(__dirname, '..');
  const dataDir = path.resolve(base, 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  return path.resolve(dataDir, 'direct_actions.json');
}

function readStore(): StoreShape {
  try {
    const p = storePath();
    if (!fs.existsSync(p)) return {};
    const txt = fs.readFileSync(p, 'utf8');
    return JSON.parse(txt || '{}');
  } catch {
    return {};
  }
}

function writeStore(obj: StoreShape): void {
  try {
    fs.writeFileSync(storePath(), JSON.stringify(obj), 'utf8');
  } catch (e) {
    console.warn('[actionPathStore] write failed', e);
  }
}

export function getGmailListActionPath(): string | undefined {
  const s = readStore();
  return s.gmail_list_action;
}

export function setGmailListActionPath(path: string): void {
  const s = readStore();
  s.gmail_list_action = path;
  writeStore(s);
}

