/**
 * In-process scheduled jobs (node-cron): periodic HN poll + daily cleanup.
 * Runs inside the single always-on service, so it shares the SQLite volume
 * directly — no separate cron worker needed.
 */
import cron from "node-cron";
import { config, telegramEnabled } from "./config.js";
import { cleanup, poll } from "./ingest.js";
import { sendDailyToAll, sendTrendsToAll } from "./telegram.js";

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

  if (telegramEnabled) {
    const tz = config.telegram.tz;
    cron.schedule(
      config.telegram.dailyCron,
      () => void sendDailyToAll().catch((e) => console.error("[scheduler] daily send failed:", e)),
      { timezone: tz },
    );
    cron.schedule(
      config.telegram.summaryCron,
      () => void sendTrendsToAll().catch((e) => console.error("[scheduler] trends send failed:", e)),
      { timezone: tz },
    );
    console.log(
      `[scheduler] telegram daily="${config.telegram.dailyCron}" trends="${config.telegram.summaryCron}" tz=${tz}`,
    );
  }

  // Kick off an initial poll shortly after boot so a fresh deploy has data.
  setTimeout(() => void runPoll(), 1000);
}
