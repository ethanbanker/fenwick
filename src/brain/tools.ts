import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Config } from '../config.ts';
import type { ToolCall } from './types.ts';
import type { Vault } from './vault.ts';
import { chownToBench, submit } from '../bench.ts';

/**
 * What he can do with his hands.
 *
 * Deliberately not a shell. He can keep a sentence for good, write and read
 * files inside data/workshop (served read-only at /world/), and run a short
 * allowlist of commands there. No shell, no absolute paths, no secrets in the
 * child's environment, a timeout, and capped output. Anything bigger than this
 * is a decision for whoever owns the machine, not a default.
 */

export type ToolOutcome = { ok: boolean; message: string; url?: string };

const COMMANDS = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'date', 'echo', 'mkdir']);

export function workshopDir(cfg: Config): string {
  const dir = path.join(cfg.dataDir, 'workshop');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function resolveInside(root: string, rel: string): string | null {
  const clean = String(rel ?? '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
  if (!clean || clean.includes('\0') || clean.includes('..')) return null;
  const full = path.resolve(root, clean);
  return full.startsWith(root + path.sep) ? full : null;
}

function spawnIn(cfg: Config, bin: string, args: string[]): ToolOutcome {
  const cwd = workshopDir(cfg);
  try {
    const res = spawnSync(bin, args, {
      cwd,
      timeout: cfg.workshop.timeoutMs,
      maxBuffer: Math.max(64_000, cfg.workshop.maxOutputBytes * 8),
      // the child never sees an API key, and HOME points at the workshop
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: cwd, LANG: 'C' },
      encoding: 'utf8',
    });
    if (res.error) return { ok: false, message: (res.error as Error).message };
    const raw = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
    const cut = raw.length > cfg.workshop.maxOutputBytes;
    const out = cut ? `${raw.slice(0, cfg.workshop.maxOutputBytes)}… (cut)` : raw;
    return { ok: res.status === 0, message: out || '(no output)' };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

export function runTool(cfg: Config, vault: Vault, tool: ToolCall | undefined, day: number): ToolOutcome | null {
  if (!tool || !tool.name) return null;

  if (tool.name === 'keep') {
    const kept = vault.keep(String(tool.text ?? ''), day);
    return {
      ok: kept.ok,
      message: kept.ok ? `kept it for good: "${kept.entry!.text}"` : `nothing kept — ${kept.reason}`,
    };
  }

  if (!cfg.workshop.enabled && tool.name !== 'keep') {
    return { ok: false, message: 'the workshop is closed' };
  }

  if (tool.name === 'write') {
    const root = workshopDir(cfg);
    const file = resolveInside(root, String(tool.path ?? ''));
    if (!file) return { ok: false, message: 'that path is outside the workshop' };
    const text = String(tool.text ?? '');
    if (!text.trim()) return { ok: false, message: 'there is nothing to write' };
    const bytes = Buffer.byteLength(text);
    if (bytes > cfg.workshop.maxFileBytes) {
      return { ok: false, message: `that file is too big (${cfg.workshop.maxFileBytes} bytes max)` };
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    // the sandbox user has to be able to edit what he wrote
    chownToBench(cfg, path.dirname(file));
    chownToBench(cfg, file);
    const rel = path.relative(root, file).split(path.sep).join('/');
    return { ok: true, message: `wrote ${rel} (${bytes} bytes)`, url: `/world/${rel}` };
  }

  if (tool.name === 'read') {
    const root = workshopDir(cfg);
    const file = resolveInside(root, String(tool.path ?? ''));
    if (!file) return { ok: false, message: 'that path is outside the workshop' };
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return { ok: false, message: 'there is no such file in the workshop' };
    const text = fs.readFileSync(file, 'utf8');
    const clipped = text.length > 4000 ? `${text.slice(0, 4000)}\n… (cut)` : text;
    return { ok: true, message: clipped || '(empty file)' };
  }

  if (tool.name === 'ask') {
    const asked = submit(cfg, String(tool.command ?? ''), String(tool.note ?? ''), day);
    return {
      ok: asked.ok,
      message: asked.ok
        ? `asked the owner to run "${String(tool.command ?? '').trim().slice(0, 100)}" — request #${asked.id} is waiting for approval. The output will come back to you next turn.`
        : `nothing sent — ${asked.reason}`,
    };
  }

  if (tool.name === 'run') {
    const parts = String(tool.command ?? '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (!parts.length) return { ok: false, message: 'no command given' };
    const [bin, ...args] = parts;

    if (bin === 'node') {
      if (args[0] !== '--check' || !args[1]) {
        return { ok: false, message: 'node is only allowed as "node --check <file>" here' };
      }
      const file = resolveInside(workshopDir(cfg), args[1]);
      if (!file) return { ok: false, message: 'that path is outside the workshop' };
      return spawnIn(cfg, process.execPath, ['--check', file]);
    }
    if (!COMMANDS.has(bin)) {
      return {
        ok: false,
        message: `"${bin}" is not available in the workshop. allowed: ${[...COMMANDS].join(', ')}, node --check`,
      };
    }
    for (const a of args) {
      if (a.startsWith('/') || a.includes('..')) return { ok: false, message: 'only paths inside the workshop' };
    }
    return spawnIn(cfg, bin, args);
  }

  return { ok: false, message: `no such tool "${String((tool as { name: string }).name)}"` };
}
