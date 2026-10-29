export type Needs = { hunger: number; fatigue: number; curiosity: number; unease: number };

export type AvailableOption = {
  id: string;
  description: string;
  args: Record<string, unknown>;
  pull: number;
  here: boolean;
};

export type Observation = {
  tick: number;
  now: number;
  day: number;
  time: string;
  minutes: number;
  night: boolean;
  darkness: number;
  weather: string;
  creature: {
    name: string;
    x: number;
    y: number;
    facing: string;
    needs: Needs;
    mood: { valence: number; energy: number };
    asleep: boolean;
    action: {
      id: string;
      label: string;
      reason: string;
      thought: string;
      startedAt: number;
      endsAt: number;
      remainingMs: number;
    } | null;
    inventory: { food: number; coins: number; trinkets: number };
    atPlace: string | null;
    moodNote: string;
  };
  place: { id: string; name: string; tags: string[]; blurb: string } | null;
  nearby: Array<{ id: string; name: string; tags: string[]; distance: number }>;
  available: AvailableOption[];
  events: Array<{ id: number; kind: string; text: string; at: number }>;
  offeringCrystals: Array<{ id: string; from: string; state: string; distance: number; waitingSince: number }>;
  pendingInspection: Array<{
    id: string;
    from: string;
    text: string;
    imagePath: string | null;
    imageMime: string | null;
  }>;
  lastFinished: { id: string; args: Record<string, unknown>; finishedAt: number } | null;
  routine: { actionsToday: Record<string, number>; visitedToday: Record<string, number>; recent: string[] };
  stats: { keptTotal: number; offeringCount: number };
};

export type ModelDecision = {
  action?: string;
  args?: Record<string, unknown>;
  reason?: string;
  thought?: string;
  feeling?: string;
};

export type InspectionVerdict = {
  keep?: boolean;
  feeling?: number;
  verdict?: string;
  reply?: string;
};
