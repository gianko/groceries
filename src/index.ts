import { loadConfig } from "./config.js";
import { createDb } from "./db.js";
import { startHeartbeat } from "./heartbeat.js";
import { scheduleNightlySnapshot } from "./snapshot.js";

const config = loadConfig();
const db = createDb(config.dbPath);

startHeartbeat(config.heartbeatPath, config.heartbeatIntervalMs);
scheduleNightlySnapshot(db.$client, config.snapshotPath, config.snapshotCron, config.tz);
