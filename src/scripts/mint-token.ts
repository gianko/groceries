// Run via SSH into the household Pi (#45): `pnpm mint-token <name>` mints or
// rotates the named person's bootstrap token and prints the full link to
// send them. Re-running for an existing name replaces their token, so
// rotation is just running this again — there's no separate revoke command.
import { systemClock } from "../clock.js";
import { loadConfig } from "../config.js";
import { createDb } from "../db.js";
import { mintPersonToken } from "../personTokens.js";

const name = process.argv[2];
if (!name) {
  console.error("Usage: pnpm mint-token <name>");
  process.exit(1);
}

const config = loadConfig();
const db = createDb(config.dbPath);
const { token } = mintPersonToken(db, systemClock, name);

console.log(`${config.webAppUrl}/bootstrap/${token}`);
