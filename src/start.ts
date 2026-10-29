import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

/**
 * Runs the world and the brain as two separate processes, the way they are meant
 * to be. If either one falls over it gets picked back up; the world saves its
 * state every thirty seconds, so a crash costs a few seconds of his life at most.
 */

const ROOT = process.cwd();
const children = new Map<string, ChildProcess>();
let stopping = false;

type Proc = { name: string; entry: string; restarts: number };

const procs: Proc[] = [
  { name: 'world', entry: path.join(ROOT, 'src', 'world', 'index.ts'), restarts: 0 },
  { name: 'brain', entry: path.join(ROOT, 'src', 'brain', 'index.ts'), restarts: 0 },
];

const COLOURS: Record<string, string> = { world: '\x1b[36m', brain: '\x1b[33m' };

function log(name: string, line: string): void {
  const colour = COLOURS[name] ?? '';
  process.stdout.write(`${colour}${line}\x1b[0m\n`);
}

function start(proc: Proc): void {
  const child = spawn(process.execPath, [proc.entry], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  children.set(proc.name, child);

  const pipe = (stream: NodeJS.ReadableStream) => {
    let buffer = '';
    stream.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        log(proc.name, buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf('\n');
      }
    });
  };
  if (child.stdout) pipe(child.stdout);
  if (child.stderr) pipe(child.stderr);

  child.on('exit', (code, signal) => {
    children.delete(proc.name);
    if (stopping) return;
    if (code === 0) {
      log(proc.name, `${proc.name} stopped cleanly. not restarting.`);
      return;
    }
    proc.restarts += 1;
    const delay = Math.min(30_000, 1000 * proc.restarts);
    log(proc.name, `${proc.name} exited (${signal ?? code}). restarting in ${delay / 1000}s`);
    setTimeout(() => {
      if (!stopping) start(proc);
    }, delay);
  });

  log(proc.name, `${proc.name} started (pid ${child.pid})`);
}

// the world comes up first; the brain waits for it by itself either way
start(procs[0]);
setTimeout(() => {
  if (!stopping) start(procs[1]);
}, 600);

function shutdown(): void {
  if (stopping) return;
  stopping = true;
  log('world', 'shutting down, saving');
  for (const [name, child] of children) {
    try {
      child.kill('SIGTERM');
    } catch {
      log(name, `could not stop ${name}`);
    }
  }
  setTimeout(() => process.exit(0), 1500);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
