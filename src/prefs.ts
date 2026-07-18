import { eq } from "drizzle-orm";
import { prefs } from "./db/schema.js";
import type { Db } from "./db.js";

const PREFS_ROW_ID = 1;

export interface Prefs {
  householdSize: number | null;
  blurb: string | null;
}

// Partial update: an absent field leaves the current value untouched, so a
// reply that only sets the blurb never clobbers the household size.
export interface PrefsUpdate {
  householdSize?: number;
  blurb?: string;
}

// Prefs hold nothing but these two fields — no staples list, no shelf-life
// data. Those live on Product rows instead (see ADR-0001's Product/Stock-Lot
// split); prefs stay a plain singleton so household size + cooking blurb are
// all the recipe flow needs to read.
export function fetchPrefs(db: Db): Prefs {
  const row = db.select().from(prefs).where(eq(prefs.id, PREFS_ROW_ID)).get();
  return { householdSize: row?.householdSize ?? null, blurb: row?.blurb ?? null };
}

export function savePrefs(db: Db, update: PrefsUpdate): Prefs {
  const current = fetchPrefs(db);
  const next: Prefs = {
    householdSize: update.householdSize ?? current.householdSize,
    blurb: update.blurb ?? current.blurb,
  };

  db.insert(prefs)
    .values({ id: PREFS_ROW_ID, householdSize: next.householdSize, blurb: next.blurb })
    .onConflictDoUpdate({
      target: prefs.id,
      set: { householdSize: next.householdSize, blurb: next.blurb },
    })
    .run();

  return next;
}

export function renderPrefs(p: Prefs): string {
  const size = p.householdSize !== null ? String(p.householdSize) : "not set";
  const blurb = p.blurb ?? "not set";
  return [
    "👨‍👩‍👧 Household prefs",
    `Size: ${size}`,
    `Cooking notes: ${blurb}`,
    "",
    'Reply to this message to update — e.g. "size: 3" or "blurb: weeknight meals under 45 min".',
  ].join("\n");
}

const SIZE_LINE = /^(?:household\s*)?size\s*[:-]?\s*(\d+)\s*$/i;
const BLURB_LINE = /^blurb\s*[:-]?\s*(.+)$/i;
const BARE_NUMBER = /^(\d+)(?:\s*(?:people|person))?$/i;

// Line-based: "size: 3" / "blurb: ..." lines are picked out explicitly, so
// one reply can update either or both fields. If neither prefix is found
// anywhere in the message, the whole reply is a bare household size (just a
// number) or otherwise the new blurb verbatim — covers the common case of
// replying with plain text like "weeknight meals under 45 min".
export function parsePrefsEdit(text: string): PrefsUpdate {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const update: PrefsUpdate = {};
  for (const line of lines) {
    const sizeMatch = line.match(SIZE_LINE);
    if (sizeMatch) {
      update.householdSize = Number(sizeMatch[1]);
      continue;
    }
    const blurbMatch = line.match(BLURB_LINE);
    if (blurbMatch) {
      update.blurb = blurbMatch[1]!.trim();
    }
  }

  if (Object.keys(update).length > 0) {
    return update;
  }

  const trimmed = text.trim();
  const bareNumberMatch = trimmed.match(BARE_NUMBER);
  return bareNumberMatch ? { householdSize: Number(bareNumberMatch[1]) } : { blurb: trimmed };
}
