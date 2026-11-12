import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.ts';

/**
 * One-way notifications to a Discord webhook (or anything that accepts the same
 * JSON). The URL is read from .env at send time, so a webhook pasted into the
 * admin panel works immediately and without restarting anything.
 */

export function envValue(name: string): string {
  try {
    const file = path.join(ROOT, '.env');
    if (!fs.existsSync(file)) return '';
    for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      if (line.slice(0, eq).trim().replace(/^export\s+/, '') !== name) continue;
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      return value;
    }
  } catch {
    /* no .env yet */
  }
  return '';
}

export function panelUrl(): string {
  const base = envValue('FENWICK_PUBLIC_URL').replace(/\/+$/, '');
  return base ? `${base}/admin` : '';
}

/** Best effort: a failed notification must never affect his life. */
export async function notifyDiscord(text: string): Promise<boolean> {
  const url = envValue('DISCORD_WEBHOOK_URL');
  if (!url || !/^https?:\/\//i.test(url)) return false;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: text.slice(0, 1900),
        allowed_mentions: { parse: [] },
      }),
      signal: AbortSignal.timeout(6000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
