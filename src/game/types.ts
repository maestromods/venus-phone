// Shapes of the game's own files (Venus University 0.4.0 / 0.5.0, save schemas 12 / 13).
// Only the fields this app reads or writes are typed; everything else is carried through untouched.

export type Sender = "player" | "contact" | "system";
export type PhotoTier = "none" | "everyday" | "suggestive" | "explicit";
export type StatKey = "brain" | "body" | "heart";
export type Stats = Record<StatKey, number>;

export interface ChatPhoto {
  tier: Exclude<PhotoTier, "none">;
  scene: string;
  file: string;
  pending?: boolean;
  failed?: boolean;
}

/** One bubble in `save.bunnyboard.conversations[charId].messages`. */
export interface ChatMessage {
  id: string;
  sender: Sender;
  text: string;
  date: number;
  time: number;
  error?: boolean;
  photo?: ChatPhoto;
  [extra: string]: unknown;
}

export interface Conversation {
  charId: string;
  messages: ChatMessage[];
  unread: number;
  summary: string | null;
  [extra: string]: unknown;
}

export interface Memory {
  date: number;
  type: string; // loved | liked | disliked | hated
  desc: string;
  [extra: string]: unknown;
}

export interface Flags {
  hasMet: boolean;
  hasCrush: boolean;
  friendZoned: boolean;
  friendZonedBy: boolean;
  isLover: boolean;
  brokenUp: number;
  hasKissed: boolean;
  hadSex: boolean;
  benefits: boolean;
  harem: boolean;
  gaveContactInfo: boolean;
  blocked: boolean;
  [extra: string]: unknown;
}

export interface CharInfo {
  memories: Memory[];
  flags?: Flags;
  nameKnown?: boolean;
  major?: string;
  year?: number;
  pursuing?: string;
  textMemory?: Memory;
  jealousyMemories?: Memory[];
  giftMemories?: Memory[];
  notes?: string;
  [extra: string]: unknown;
}

export interface SaveFile {
  schemaVersion: number;
  /** Absent for the first semester; otherwise a key in the playthrough's semesters. */
  semester?: string;
  saveDate: number;
  date: number;
  time: number;
  stats: Stats;
  bio?: string;
  charInfo: Record<string, CharInfo>;
  bunnyboard: {
    conversations: Record<string, Conversation>;
    [extra: string]: unknown;
  };
  [extra: string]: unknown;
}

export interface PlaythroughRecord {
  chars: string[];
  playerFirstName: string;
  playerLastName: string;
  name?: string;
  profiles?: Record<string, CharacterProfile>;
  semesters?: Record<string, SemesterRecord>;
  [extra: string]: unknown;
}

export interface CharacterProfile {
  major?: string;
  year?: number;
  pursuing?: string;
  [extra: string]: unknown;
}

export interface SemesterRecord {
  index: number;
  chars: string[];
  alumni: string[];
  profiles: Record<string, CharacterProfile>;
  [extra: string]: unknown;
}

export interface CustomOutfit {
  name?: string;
  tags: string[];
}

export interface Character {
  charId: string;
  firstName: string;
  lastName: string;
  personality: string;
  behavior: Record<string, string>;
  backstory: string;
  datingHistory?: string;
  datingPreference?: string;
  kinks?: string;
  isVirgin?: boolean;
  likes: string[];
  dislikes: string[];
  traits: string[];
  preferredStat?: StatKey;
  baseAppearance: string[];
  outfit: string[];
  peOutfit: string[];
  swimOutfit: string[];
  customOutfits?: Record<string, CustomOutfit | undefined>;
  negativeTags?: string[];
  body?: Record<string, string | undefined>;
  profileCrop?: { x: number; y: number; width: number; height: number };
  [extra: string]: unknown;
}

export function emptyFlags(): Flags {
  return {
    hasMet: false,
    hasCrush: false,
    friendZoned: false,
    friendZonedBy: false,
    isLover: false,
    brokenUp: 0,
    hasKissed: false,
    hadSex: false,
    benefits: false,
    harem: false,
    gaveContactInfo: false,
    blocked: false,
  };
}

export function hasTrait(character: Pick<Character, "traits"> | undefined, trait: string): boolean {
  return character?.traits?.includes(trait) ?? false;
}
