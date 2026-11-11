import type { Config } from '../config.ts';

/**
 * A very small Discord bridge: gateway in, messages out.
 *
 * Deliberately dependency-free — the project runs on node alone, so this speaks
 * the gateway protocol over node's built-in WebSocket instead of pulling in a
 * library. It is a bridge and nothing more: what he says is decided by the brain.
 */

export type IncomingChat = {
  id: string;
  from: string;
  text: string;
  channelId: string;
  at: number;
};

export type DiscordBridge = {
  enabled: boolean;
  /** messages waiting to be answered, oldest first */
  pending: () => IncomingChat[];
  /** take up to `max` waiting messages, oldest first */
  drain: (max?: number) => IncomingChat[];
  say: (text: string, to?: string) => Promise<boolean>;
  status: () => string;
};

const API = 'https://discord.com/api/v10';

/** guilds | guild messages | direct messages | message content */
const INTENTS = 1 | 512 | 4096 | 32768;

const MAX_QUEUE = 24;

const off = (why: string): DiscordBridge => ({
  enabled: false,
  pending: () => [],
  drain: () => [],
  say: async () => false,
  status: () => why,
});

export function startDiscord(cfg: Config, log: (msg: string) => void): DiscordBridge {
  const token = cfg.discord.token;
  const channelId = cfg.discord.channelId;
  if (!token || !channelId) {
    log('discord: bridge off (set DISCORD_BOT_TOKEN and DISCORD_CHANNEL_ID to turn it on)');
    return off('off');
  }

  const WS = (globalThis as { WebSocket?: new (url: string) => any }).WebSocket;
  if (typeof WS !== 'function') {
    log('discord: this node has no WebSocket; bridge off');
    return off('unsupported');
  }

  const queue: IncomingChat[] = [];
  const seen = new Set<string>();
  let ws: any = null;
  let seq: number | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let waitedForAck = true;
  let botId = '';
  let retryDelay = 1500;
  let closed = false;
  let lastSendAt = 0;
  let connection = 'starting';

  function send(payload: unknown): void {
    try {
      ws?.send(JSON.stringify(payload));
    } catch {
      /* the socket will close by itself */
    }
  }

  function heartbeat(): void {
    send({ op: 1, d: seq });
    waitedForAck = false;
  }

  function startHeartbeat(ms: number): void {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      // no ack last time round: the gateway is a zombie, start over
      if (!waitedForAck) {
        try {
          ws?.close();
        } catch {
          /* ignore */
        }
        return;
      }
      heartbeat();
    }, Math.max(5000, ms));
  }

  function enqueue(msg: any): void {
    const channel = String(msg.channel_id ?? '');
    if (!channel) return;
    let text = String(msg.content ?? '').trim();
    const mentioned = botId !== '' && (msg.mentions ?? []).some((m: any) => m?.id === botId);
    if (botId) text = text.replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim();
    if (!text) {
      if (!mentioned) return;
      text = '(they just looked at you)';
    }
    const id = String(msg.id ?? '');
    if (!id || seen.has(id)) return;
    seen.add(id);
    if (seen.size > 400) seen.clear();

    const from = String(msg.author?.global_name || msg.author?.username || 'someone').slice(0, 60);
    queue.push({ id, from, text: text.slice(0, 1200), channelId: channel, at: Date.now() });
    while (queue.length > MAX_QUEUE) queue.shift();
    log(`discord: ${from} says "${text.slice(0, 90)}"`);
  }

  function onPacket(raw: string): void {
    let pkt: any;
    try {
      pkt = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof pkt?.s === 'number') seq = pkt.s;

    if (pkt?.op === 10) {
      startHeartbeat(Number(pkt.d?.heartbeat_interval) || 41_250);
      heartbeat();
      send({
        op: 2,
        d: {
          token,
          intents: INTENTS,
          properties: { os: process.platform, browser: 'fenwick', device: 'fenwick' },
        },
      });
      return;
    }
    if (pkt?.op === 11) {
      waitedForAck = true;
      return;
    }
    if (pkt?.op === 1) {
      heartbeat();
      return;
    }
    if (pkt?.op === 7 || pkt?.op === 9) {
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      return;
    }
    if (pkt?.op !== 0) return;

    if (pkt.t === 'READY') {
      botId = String(pkt.d?.user?.id ?? '');
      retryDelay = 1500;
      connection = `connected as ${pkt.d?.user?.username ?? '?'}`;
      log(`discord: ${connection}`);
      return;
    }
    if (pkt.t === 'MESSAGE_CREATE') {
      const msg = pkt.d;
      if (!msg || msg.author?.bot) return;
      // a channel is his room; he does not read every room he was invited to
      const isDM = !msg.guild_id;
      if (!isDM && String(msg.channel_id) !== channelId) return;
      enqueue(msg);
    }
  }

  function scheduleRetry(): void {
    if (closed) return;
    const delay = retryDelay;
    retryDelay = Math.min(60_000, Math.round(retryDelay * 1.7));
    setTimeout(connect, delay);
  }

  function connect(): void {
    if (closed) return;
    connection = 'connecting';
    try {
      ws = new WS('wss://gateway.discord.gg/?v=10&encoding=json');
    } catch (err) {
      log(`discord: could not open the gateway (${(err as Error).message})`);
      scheduleRetry();
      return;
    }
    ws.onmessage = (ev: any) => {
      try {
        onPacket(typeof ev?.data === 'string' ? ev.data : '');
      } catch (err) {
        log(`discord: bad packet (${(err as Error).message})`);
      }
    };
    ws.onclose = (ev: any) => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (closed) return;
      connection = 'reconnecting';
      log(`discord: gateway closed (${ev?.code ?? '?'}); trying again in ${Math.round(retryDelay / 1000)}s`);
      scheduleRetry();
    };
    ws.onerror = () => {
      /* onclose always follows */
    };
  }

  async function say(text: string, to?: string): Promise<boolean> {
    const body = String(text ?? '').trim();
    if (!body) return false;
    const target = to || channelId;
    const chunks = body.length <= 1900 ? [body] : body.match(/[\s\S]{1,1900}/g) ?? [];
    for (const chunk of chunks) {
      const wait = 1100 - (Date.now() - lastSendAt);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      try {
        const res = await fetch(`${API}/channels/${target}/messages`, {
          method: 'POST',
          headers: { authorization: `Bot ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ content: chunk, allowed_mentions: { parse: [] } }),
          signal: AbortSignal.timeout(15_000),
        });
        lastSendAt = Date.now();
        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          log(`discord: could not send (${res.status}) ${detail.slice(0, 180)}`);
          return false;
        }
      } catch (err) {
        log(`discord: send failed (${(err as Error).message})`);
        return false;
      }
    }
    return true;
  }

  connect();

  return {
    enabled: true,
    pending: () => queue.slice(),
    drain: (max = 4) => queue.splice(0, max),
    say,
    status: () => connection,
  };
}
