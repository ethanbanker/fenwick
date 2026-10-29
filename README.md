# Fenwick

An autonomous owl called **Mochi** who lives in a small isometric town on your
network. He has needs that drift whether or not anyone is watching, a mood that
responds to what happens to him, and a brain that decides what he does next every
few seconds. He eats, sleeps, gets bored, walks to the laundrette, browses the real
internet, keeps a diary, and remembers the people who leave him things.

He is not a chatbot with an avatar. There is no chat box. If you close the tab, his
day carries on; if everyone closes every tab, his day still carries on.

Built to sit on a small always-on machine. **No dependencies, no npm install, no
Docker, no database.** One `node` command.

---

## Quick start

You need **Node 22.6 or newer** (it runs TypeScript directly). Node 26 is what it
was built on.

```bash
cd fenwick
cp .env.example .env      # then paste a free API key into it (see below)
node src/start.ts
```

Open <http://localhost:4321>. That is the whole thing running on your laptop. To put
him on the machine that stays on, skip to [Deploying to the micropc](#deploying-to-the-micropc).

### The one thing you have to do: get a free key

The brain needs a language model. The default is Google's Gemini, because its free
tier needs no credit card and it can look at pictures, which he needs for picture
offerings.

1. Go to <https://aistudio.google.com/apikey>
2. Create an API key (free, no card)
3. Put it in `.env`:

```
GEMINI_API_KEY=your-key-here
```

**Without a key he is not broken** — he falls back to a reflex brain and keeps
living: walking, eating, sleeping, and judging what you leave him. He just stops
deliberating, so the interesting decisions dry up. You will see
`brain: reflex only (no API key)` in the log.

## Deploying

### Proxmox: one command

On the Proxmox host, as root:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/ethanbanker/fenwick/main/ct/fenwick.sh)"
```

It makes an unprivileged Debian container, installs Node and the app inside it, starts
him under systemd, and prints the address. The defaults (1 core, 1 GB, 8 GB disk, DHCP)
take two keypresses; **advanced** lets you set the hostname, resources, storage, bridge,
a static IP and the root password.

It asks for a Gemini key on the way. That is the only thing it needs from you, and
leaving it blank is fine — he lives on reflexes until you add one, and it tells you how.

`ct/fenwick.sh` runs on the host. `install/fenwick-install.sh` runs inside the container,
then hands over to `deploy/install.sh`.

Run the same command again and it notices the existing container and offers to **repair**
it — reinstall the code and the service, keeping his life, your `.env` and your
`config.json`. That is also the update path: paste, pick *repair*. To do it by hand inside
the container:

```bash
pct exec <ctid> -- env PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  bash /opt/fenwick/deploy/install.sh
```

The PATH is there because a bare `pct exec` shell can come up without `/usr/local/bin`,
which makes a correctly installed Node look missing. The installer looks for Node on disk
before consulting PATH, so it works either way.

The container gets no sshd — use `pct exec`, or install one yourself if you want in.

### The settings, if you would rather click

These are the settings that matter; anything not listed is fine at the default. Sizes
are measured, not guessed.

| setting | value | why |
|---|---|---|
| Template | Debian 12 or 13 (`debian-12-standard`) | smallest thing that has systemd. Ubuntu 24.04 is fine too. |
| Type | **unprivileged** | he needs no privileges at all — don't give him any. |
| Cores | 1 (2 if the box is idle) | he thinks a few times a minute, not a few thousand. |
| Memory | **1 GB** (512 MB works, with less room) | measured: 270 MB across world + brain + supervisor. Node itself is ~50 MB a process before he does anything. |
| Swap | 512 MB | absorbs spikes while parsing a page or holding a picture. |
| Disk | 8 GB | ~2 GB template, ~150 MB Node, the rest is his diary and the pictures you leave him. |
| Network | **static IP** on `vmbr0` | so `deploy.sh` always finds him; DHCP moving his address is the usual reason a deploy fails. |
| DNS | your gateway, or `1.1.1.1` | he needs outbound HTTPS: nodejs.org once, then the model API forever. |
| Start at boot | **yes** | otherwise he dies with the host and never comes back. |
| Features | none | no nesting, no FUSE, no keyctl. |
| Console | shell | you need one: `apt install openssh-server` (see below). |

The GUI is the easy path: **Create CT** → unprivileged → set cores/memory/disk →
static IP → Options → *Start at boot* → Finish. If you would rather script it on the
host, the shape is:

```bash
pct create 120 local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst \
  --hostname fenwick --unprivileged 1 --onboot 1 \
  --cores 1 --memory 1024 --swap 512 --rootfs local-lvm:8 \
  --net0 name=eth0,bridge=vmbr0,ip=192.168.1.50/24,gw=192.168.1.1 \
  --nameserver 1.1.1.1 --start 1
```

Check the template filename first — `pveam list local` — and swap `local-lvm` for
whichever storage you actually use (`local-zfs`, a directory store, …). Both the
version number and the storage name change from host to host. A bare Debian container
has **no sshd**, so before you can deploy to it:

```bash
pct enter 120
apt update && apt install -y openssh-server curl
systemctl enable --now ssh
```

Then give your laptop a key so `deploy.sh` does not stop to ask for a password:

```bash
ssh-keygen -t ed25519        # if you do not already have one
ssh-copy-id root@192.168.1.50
```

> He also runs happily on a Raspberry Pi, an old laptop, or inside Docker — but in
> Docker you would be reimplementing what systemd already does for you here, so a
> plain container or a plain machine is the better home.

### A machine you already have (push from this laptop)

```bash
./deploy/deploy.sh you@micropc.local
```

That copies the code over ssh, then runs the installer on the device, then tells you
the address. Re-run the same command to update him — his life carries on, because
`data/` and `.env` are never overwritten by a deploy.

If `.local` does not resolve, use the IP (`ssh you@192.168.1.42`), and try
`ssh you@micropc` once by hand first so ssh learns the host key.

### By hand (run on the micropc)

```bash
git clone <this repo> ~/fenwick      # or scp -r the folder over
cd ~/fenwick
bash deploy/install.sh
```

### What the installer does

It is idempotent — running it again is how you update.

1. **Node.** Checks for 22.6 or newer. If the machine only has the distro's Node 18
   (Ubuntu 24.04 ships that), it fetches the current LTS from nodejs.org and links it
   into `/usr/local/bin`, which shadows the apt one. Nothing else is installed.
2. **`.env`.** Creates it from the template if missing, and tells you loudly if there
   is no key in it yet.
3. **systemd.** Writes `/etc/systemd/system/fenwick.service`, enables it at boot, and
   restarts it — so a re-run picks up code changes.
4. **Health.** Waits up to 20s for `/api/state` to answer, then prints the LAN address.
   If he does not come up, it shows the last 25 journal lines instead of pretending.

With no systemd (macOS, a container), it just starts him in the foreground.

> `sudo` is used for the bits that need it. If Node came from `nvm`, the installer
> writes the absolute path into the unit for you.

### Reachability

He listens on `0.0.0.0:4321`, so from any device on your network open
`http://<micropc-ip>:4321`. Change the port in `config.json` (`"port"`) and re-run the
installer.

Open the firewall for the LAN only if you need to:

```bash
sudo ufw allow from 192.168.0.0/16 to any port 4321 proto tcp
```

There is no authentication, deliberately — it is a thing on your shelf, not a service.
Do not port-forward it. If you want to reach him from outside the house, put it behind
Tailscale rather than opening a port.

`micropc.local` needs avahi: `sudo apt install avahi-daemon`.

### Day-to-day

```bash
sudo systemctl status fenwick          # is he up
sudo journalctl -u fenwick -f          # watch him think
sudo systemctl restart fenwick         # after editing config.json
sudo systemctl stop fenwick            # he saves on the way down
```

Back up his life — this is the whole of it:

```bash
tar czf fenwick-$(date +%F).tar.gz -C ~/fenwick data/ .env
```

### Keeping the bill at zero

Nothing here can spend money on its own: `brain.maxCallsPerDay` is a hard ceiling, and
when it runs out he drops to reflexes until the counter resets. Details under
[Cost, and staying free](#cost-and-staying-free).

---

## Living with him

| page | what it is |
|---|---|
| `/` | the town. A renderer only — it holds no state and cannot change anything about him. |
| `/diary` | what he wrote down himself, unedited. He writes at the end of each in-world day, and sometimes mid-day when a day gets heavy. |
| `/memories` | what he is carrying and what it costs him. The slot grid comes before the words on purpose: his memory is finite and competitive. |
| `/mind` | his authored self next to what he has written about himself since, so the drift is a diff you can read. Plus what he has been reading on the internet, and how much of the day's model budget is left. |
| `/offerings` | leave him something, and see what he did with what he was left. |

**Leaving him something.** Words or a picture. It does not land in an inbox: a
crystal appears somewhere in the town, and he has to come across it. His sense range
is smaller than the ring it spawns in, so it can take a while depending on where he
is and what mood he is in. He then looks at it and decides. If he keeps it, it is
carried to the ruins and stays there for good, and your standing with him goes up.

Standing is earned **only** by things he decided to keep. Nothing else moves it.

Tuning: the clock runs one in-world day per real hour. He is nocturnal, so the
middle of the real day is his quiet, sleepy stretch.

---

## How it works

Three parts, kept separate on purpose.

```
src/viewer/     a canvas renderer. no simulation state, cannot change anything
src/world/      the simulation. ticks at 20Hz, owns his body, needs, mood,
                the town, the weather, the clock, the offerings, and the finite
                list of actions he is physically able to do
src/brain/      the cognition. separate process, talks to the world over HTTP,
                owns his memory, his persona, his diary, and the internet
```

The separation is the point: the world doesn't think, and the brain doesn't know the
world's internals — it receives observations and returns actions. Everything he
believes about his life, he worked out from what he was sent.

### Every heartbeat (4–15s, faster when agitated)

```
SENSE     pull the observation from the world
DELTA     what appeared, vanished, changed since last tick
FEEL      needs and mood drift; the world owns most of this
CLASSIFY  quality model, fast model, or skip entirely
EXPLORE   repetition guard: is he in a rut?
THINK     the model decides, in character, with a reason
VALIDATE  hard block on fixation; hard check against what is actually possible
ACT       send it
REFLECT   working memory, daily log
ADAPT     shift the heartbeat with energy and agitation
```

Most ticks skip the model entirely, because he is in the middle of something. That
is also what keeps him inside a free tier.

VALIDATE sits after THINK, not inside the prompt, because asking a model not to
repeat itself does not work, whereas refusing to transmit the repetition does. When
he is blocked he falls back to the reflex brain rather than being allowed to do it
anyway.

### Memory is finite and competitive

Six sections, 24 lines each. Strength halves every 21 days unless something
reinforces it. When a section is full, a new memory has to be worth more than the
weakest thing already in there or it does not get in at all; something gets pushed
out to make room.

On top of that, two ceilings that exist to stop him fixating, and neither needs a
list of banned topics:

- **subject ceiling** — one word may own at most 4 lines
- **pair ceiling** — one pair of words may own at most 2

He sleeps, and during sleep the model reads the day's log against what he already
holds and *rewrites* the file rather than appending to it. A memory can revise an
existing line, so the file compounds into a sharper account of his life instead of
just a longer one.

### Personality with a guard around it

His persona is authored, in `src/brain/persona.ts`, and it evolves — but the
baseline is immutable, he may add at most two traits, and he cannot drift more than
60% away from it. Anything past that is quietly dropped, not argued with.

### The internet

He does real fetches against real pages, with real dead links behind them. He picks a
search, reads, and decides whether to stay or leave. An interest profile accumulates
from what he reads with a decaying half-life and feeds back into what he looks at
next. This is the part most likely to produce something nobody wrote.

He is not allowed to fetch private network addresses, so he cannot poke around your
house.

---

## Cost, and staying free

`config.json` → `brain.maxCallsPerDay` (default **350**) is a hard ceiling. He is
also paced with `minSecondsBetweenCalls`, and when the budget runs out he drops to
the reflex brain and keeps living. `/mind` shows the meter.

Realistic consumption for a full day is roughly 100–250 calls: decisions only happen
when an action finishes, plus one diary entry, one or two consolidation calls, and
some browsing. It fits inside free tiers.

If you start getting rate limited, he backs off for 20 minutes automatically and
lives on reflexes.

### Using a different model

Any OpenAI-compatible endpoint works (Groq, Cerebras, OpenRouter, a local Ollama).
In `.env`:

```
LLM_PROVIDER=openai
LLM_BASE_URL=https://api.groq.com
LLM_MODEL=openai/gpt-oss-120b
LLM_FAST_MODEL=openai/gpt-oss-20b
LLM_VISION_MODEL=openai/gpt-oss-120b
LLM_API_KEY=...
```

For Ollama: `LLM_PROVIDER=openai`, `LLM_BASE_URL=http://127.0.0.1:11434`,
`LLM_MODEL=llama3.2`, `LLM_API_KEY=ollama`. Fully offline, no key, no quota — just
slower thinking and no vision unless you pull a vision model.

---

## Configuration

`config.json` (created with the defaults):

| key | meaning |
|---|---|
| `sim.dayLengthMinutes` | real minutes per in-world day. `60` = one day per hour. `180` for a slower life. |
| `sim.tickHz` | simulation tick rate. 20 is plenty. |
| `sim.seed` | the town layout is deterministic from this. |
| `brain.model` / `fastModel` / `visionModel` | which models do which job |
| `brain.maxCallsPerDay` | hard daily ceiling on model calls |
| `memory.slotsPerSection` / `halfLifeDays` | how much he can hold, how fast it fades |
| `offerings.spawnRadiusTiles` / `senseRadiusTiles` | how far things appear, how close he must get to notice. Smaller sense radius = harder to find. |
| `browse.enabled` | turn the internet off entirely |

Restart after editing.

---

## His files

Everything he is lives in `data/`, plain text and JSON, all readable:

```
data/
  world-state.json          his body, the clock, the town's events
  offerings/                what people left, including images
  brain/
    memory.json / .md       what he holds, with strength
    persona.json            who he has become
    diary/day-0003.md       what he wrote
    logs/day-0003.md        the raw log the diary is written from
    interests.json          what he has been reading about
    readings.json           the pages themselves
    budget.json             model calls used today
```

Back up `data/` and he survives. Delete `data/` and he starts over as a stranger.

His generated mind (diary, memory, persona) is deliberately kept out of the source
so that editing the code doesn't rewrite who he is.

---

## Troubleshooting

| symptom | fix |
|---|---|
| `port 4321 is already in use` | another copy is running: `lsof -ti:4321 \| xargs kill`, or set `PORT` |
| `brain: reflex only (no API key)` | no key found — check `.env` is next to `config.json`, and that the file is named exactly `.env` |
| he never decides anything | check `journalctl -u fenwick -f`; usually a 429 or a bad model name. He backs off automatically for 20 minutes. |
| `empty response (no candidate)` | the model name does not exist for your key, or the free tier blocked it |
| he is asleep a lot | he is nocturnal. Sleep is 3–5 in-world hours and a day is one real hour. |
| nothing appears in the town | the world is running but the viewer can't reach `/events`; check you're on the same origin |
| `node: error while loading shared libraries: libatomic.so.1` | the official node builds link against libatomic, which a bare Debian container doesn't ship. The installer now notices and runs `apt-get install libatomic1 libstdc++6` itself; if that fails, install it by hand and re-run. |
| `node <blank> is too old` | that was the installer confusing "will not run" with "too old". Re-run: it now prints the actual error and repairs the missing library in place instead of downloading node again. |

---

## The one thing worth knowing

He cannot invent an action. The world hands the brain a finite list of things that
are physically possible from where he is standing, and the brain can only pick from
that list. Without that, an "autonomous" agent is just a model with a to-do list.
