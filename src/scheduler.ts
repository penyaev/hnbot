/**
 * In-process scheduled jobs (node-cron): periodic HN poll + daily cleanup.
 * Runs inside the single always-on service, so it shares the SQLite volume
 * directly — no separate cron worker needed.
 */
import cron from "node-cron";
import { config } from "./config.js";
import { cleanup, poll } from "./ingest.js";

let polling = false;

/** Run a poll, guarding against overlap if a previous run is still in flight. */
export async function runPoll(): Promise<void> {
  if (polling) {
    console.warn("[scheduler] poll already running, skipping this tick");
    return;
  }
  polling = true;
  try {
    await poll();
  } catch (e) {
    console.error("[scheduler] poll failed:", e);
  } finally {
    polling = false;
  }
}

export function startScheduler(): void {
  cron.schedule(config.pollCron, () => void runPoll());
  cron.schedule(config.cleanupCron, () => {
    try {
      cleanup();
    } catch (e) {
      console.error("[scheduler] cleanup failed:", e);
    }
  });
  console.log(`[scheduler] poll="${config.pollCron}" cleanup="${config.cleanupCron}"`);

  // Kick off an initial poll shortly after boot so a fresh deploy has data.
  setTimeout(() => void runPoll(), 1000);
}
