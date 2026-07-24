export const ACTOR_TYPES = [
  "SYSTEM",
  "HUMAN",
  "N8N",
  "TELEGRAM",
  "LLM",
] as const;

export type ActorType = (typeof ACTOR_TYPES)[number];

export interface Actor {
  readonly id: string;
  readonly type: ActorType;
}

export type IdempotencyKey = string;
export type IsoDateTime = string;

