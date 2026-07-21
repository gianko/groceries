import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Clock } from "./clock.js";
import { personTokens } from "./db/schema.js";
import type { Db } from "./db.js";

export interface PersonToken {
  id: number;
  name: string;
  token: string;
}

// Rotation = re-run: mints a fresh random token for `name`, replacing
// whatever token that name had before (per #45's CLI script requirement).
// Nothing reads the old token again once this returns, so there's no
// transition window to worry about.
export function mintPersonToken(db: Db, clock: Clock, name: string): PersonToken {
  const token = randomBytes(32).toString("base64url");
  const createdAt = clock.now().toISOString();

  const existing = db.select().from(personTokens).where(eq(personTokens.name, name)).get();
  if (existing) {
    const [updated] = db
      .update(personTokens)
      .set({ token, createdAt })
      .where(eq(personTokens.id, existing.id))
      .returning()
      .all();
    return updated!;
  }

  const [created] = db.insert(personTokens).values({ name, token, createdAt }).returning().all();
  return created!;
}

export function fetchPersonTokens(db: Db): PersonToken[] {
  return db.select().from(personTokens).all();
}
