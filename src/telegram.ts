/**
 * Telegram delivery layer. Integrated into the main service (not a separate
 * process): it calls the in-process getTopStories/getSummary directly, sends
 * scheduled messages, and handles the "More stories" inline button via webhook.
 *
 * Per-chat dedup: each subscriber draws from its own feed `tg-<chatId>`, so the
 * daily message and every "More stories" tap walk that chat down the window's
 * best stories with no repeats, independently of other chats.
 */
import { createHash } from "node:crypto";
import { config, telegramEnabled } from "./config.js";
import { addSubscriber, listSubscriberChatIds, removeSubscriber } from "./db.js";
import { getTopStories, type TopStory } from "./topStories.js";
import { getSummary } from "./summary.js";
import { ask } from "./ask.js";

const API = `https://api.telegram.org/bot${config.telegram.botToken}`;

/** Stable secret for the webhook (derived from the bot token, so no extra config). */
export const webhookSecret = telegramEnabled
  ? createHash("sha256").update(config.telegram.botToken).digest("hex").slice(0, 32)
  : "";

const MORE_BUTTON = {
  inline_keyboard: [[{ text: "📥 More stories", callback_data: "more" }]],
};

interface TgResponse {
  ok: boolean;
  description?: string;
  result?: unknown;
}

async function tg(method: string, body: Record<string, unknown>): Promise<TgResponse> {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as TgResponse;
  if (!data.ok) console.error(`[telegram] ${method} failed:`, data.description);
  return data;
}

// ---- formatting helpers ----

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function age(hours: number): string {
  if (hours < 1) return "just now";
  if (hours < 48) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function formatStories(stories: TopStory[]): string {
  return stories
    .map((s, i) => {
      const link = s.url ?? s.hnUrl;
      const meta = `${s.score} pts · ${s.descendants ?? 0} 💬 · <a href="${esc(s.hnUrl)}">HN</a> · ${age(s.ageHours)}`;
      return `${i + 1}. <a href="${esc(link)}">${esc(s.title)}</a>\n   ${meta}`;
    })
    .join("\n\n");
}

/** Convert the summary's Markdown into Telegram-safe HTML. */
function mdToHtml(md: string): string {
  let t = esc(md);
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, txt, url) => `<a href="${url}">${txt}</a>`);
  t = t.replace(/^#{1,6}\s*(.+)$/gm, "<b>$1</b>"); // headings -> bold
  t = t.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  t = t.replace(/__([^_]+)__/g, "<b>$1</b>");
  t = t.replace(/^\s*[-*]\s+/gm, "• ");
  t = t.replace(/^\s*-{3,}\s*$/gm, ""); // horizontal rules
  t = t.replace(/\n{3,}/g, "\n\n");
  return t.trim();
}

/** Split text into <=4096-char chunks on line boundaries (Telegram limit). */
function chunk(text: string, max = 3800): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let buf = "";
  for (const line of text.split("\n")) {
    if (buf.length + line.length + 1 > max) {
      if (buf) out.push(buf);
      buf = line;
    } else {
      buf = buf ? `${buf}\n${line}` : line;
    }
  }
  if (buf) out.push(buf);
  return out;
}

function feedFor(chatId: string): string {
  return `tg-${chatId}`;
}

function authorized(userId: number | string | undefined): boolean {
  if (config.telegram.allowedUserIds.length === 0) return true; // open mode
  return userId != null && config.telegram.allowedUserIds.includes(String(userId));
}

// ---- senders ----

async function sendText(chatId: string, text: string, withButton = false): Promise<void> {
  await tg("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(withButton ? { reply_markup: MORE_BUTTON } : {}),
  });
}

/** Send the next batch of top stories to a chat (used by the button + daily send). */
export async function sendTopStoriesTo(chatId: string, header = "🔥 <b>Top Hacker News</b>"): Promise<void> {
  const { stories } = getTopStories({ n: config.telegram.stories, feed: feedFor(chatId) });
  if (stories.length === 0) {
    await sendText(chatId, "📭 You're all caught up — no more stories in the current window.");
    return;
  }
  await sendText(chatId, `${header}\n\n${formatStories(stories)}`, true);
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** An indeterminate progress bar frame (a filled bar that grows and repeats). */
function progressBar(frame: number): string {
  const width = 10;
  const filled = (frame % width) + 1;
  return "▰".repeat(filled) + "▱".repeat(width - filled);
}

async function editText(chatId: string, messageId: number, text: string, disablePreview = false): Promise<void> {
  await tg("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    ...(disablePreview ? { disable_web_page_preview: true } : {}),
  });
}

/**
 * Post a placeholder with an animated progress bar, run `worker`, then replace
 * the placeholder in place with the resulting HTML chunks (extra chunks sent as
 * new messages). The animation loop is awaited before the final edit so a stray
 * frame can't overwrite the result. Used for anything with a noticeable wait.
 */
async function runWithProgress(
  chatId: string,
  label: string,
  worker: () => Promise<string[]>,
): Promise<void> {
  const waiting = (frame: number) => `${label}\n${progressBar(frame)}`;
  const placeholder = await tg("sendMessage", {
    chat_id: chatId,
    text: waiting(0),
    parse_mode: "HTML",
  });
  const messageId = (placeholder.result as { message_id?: number } | undefined)?.message_id;

  let done = false;
  const animate = async (): Promise<void> => {
    let frame = 1;
    while (!done && messageId) {
      for (let t = 0; t < 2000 && !done; t += 200) await delay(200); // interruptible wait
      if (done) break;
      await editText(chatId, messageId, waiting(frame++)).catch(() => {});
    }
  };
  const anim = animate();

  try {
    const chunks = await worker();
    done = true;
    await anim; // ensure no bar edit is still in flight before writing the result
    const first = chunks[0] ?? "(no result)";
    if (messageId) await editText(chatId, messageId, first, true);
    else await sendText(chatId, first);
    for (const part of chunks.slice(1)) await sendText(chatId, part);
  } catch (e) {
    done = true;
    await anim;
    console.error(`[telegram] ${label} failed:`, e);
    const err = "⚠️ Something went wrong — try again in a moment.";
    if (messageId) await editText(chatId, messageId, err);
    else await sendText(chatId, err);
  }
}

/** Send the trends summary to a chat (with progress bar). */
export async function sendTrendsTo(chatId: string): Promise<void> {
  await runWithProgress(chatId, "📊 <b>Generating HN trends…</b>", async () => {
    const { summary, days } = await getSummary({});
    const header = `📊 <b>HN trends — last ${days} days</b>`;
    const chunks = chunk(mdToHtml(summary));
    return [`${header}\n\n${chunks[0]}`, ...chunks.slice(1)];
  });
}

/** Answer a natural-language question via the search agent (with progress bar). */
export async function sendAnswerTo(chatId: string, question: string): Promise<void> {
  await runWithProgress(chatId, "🔎 <b>Searching the archive…</b>", async () => {
    const { answer } = await ask(question);
    return chunk(mdToHtml(answer));
  });
}

// ---- scheduled fan-out ----

export async function sendDailyToAll(): Promise<void> {
  const chats = listSubscriberChatIds();
  console.log(`[telegram] daily send to ${chats.length} subscriber(s)`);
  for (const chatId of chats) await sendTopStoriesTo(chatId);
}

export async function sendTrendsToAll(): Promise<void> {
  const chats = listSubscriberChatIds();
  console.log(`[telegram] trends send to ${chats.length} subscriber(s)`);
  for (const chatId of chats) await sendTrendsTo(chatId);
}

// ---- incoming updates (webhook) ----

interface TgUser {
  id: number;
  username?: string;
}
interface TgUpdate {
  message?: { chat: { id: number }; from?: TgUser; text?: string };
  callback_query?: { id: string; data?: string; from?: TgUser; message?: { chat: { id: number } } };
}

const WELCOME =
  "👋 <b>Subscribed!</b>\n\n" +
  "You'll get the top Hacker News stories every morning, plus a trends summary twice a week.\n\n" +
  "Commands:\n" +
  "• /top — top stories now\n" +
  "• /trends — trends summary now\n" +
  "• /stop — unsubscribe\n\n" +
  "💬 Or just ask me a question, like <i>what's new around Rust lately</i> or " +
  "<i>was there anything about OpenAI this week</i>.\n\n" +
  "Tap <b>More stories</b> under any digest to pull the next batch.";

const ASK_HINT =
  "💬 Ask me about recent Hacker News stories, e.g.:\n" +
  "• <i>what's new around Rust lately</i>\n" +
  "• <i>was there anything about OpenAI this week</i>\n" +
  "• <i>what was that story about a GitHub supply-chain attack</i>";

export async function handleUpdate(update: TgUpdate): Promise<void> {
  if (update.message) {
    const { chat, from, text } = update.message;
    const chatId = String(chat.id);
    if (!authorized(from?.id)) {
      await sendText(
        chatId,
        `🔒 Not authorized. Your Telegram user id is <code>${from?.id}</code> — ask the admin to add it to TELEGRAM_ALLOWED_USER_IDS.`,
      );
      return;
    }
    const body = (text ?? "").trim();
    if (!body.startsWith("/")) {
      // Any non-command message is a natural-language question for the agent.
      if (body) await sendAnswerTo(chatId, body);
      return;
    }
    const cmd = body.split(/\s+/)[0].split("@")[0].toLowerCase(); // strip @BotName in groups
    switch (cmd) {
      case "/start":
        addSubscriber(chatId, String(from?.id ?? ""), from?.username ?? null);
        await sendText(chatId, WELCOME);
        await sendTopStoriesTo(chatId);
        break;
      case "/stop":
        removeSubscriber(chatId);
        await sendText(chatId, "👋 Unsubscribed. Send /start anytime to resume.");
        break;
      case "/top":
        await sendTopStoriesTo(chatId);
        break;
      case "/trends":
        await sendTrendsTo(chatId);
        break;
      case "/ask": {
        const q = body.slice(cmd.length).trim();
        if (q) await sendAnswerTo(chatId, q);
        else await sendText(chatId, ASK_HINT);
        break;
      }
      default:
        await sendText(
          chatId,
          "Commands: /ask, /top, /trends, /start, /stop.\nOr just ask a question in plain English.",
        );
    }
    return;
  }

  if (update.callback_query) {
    const cq = update.callback_query;
    await tg("answerCallbackQuery", { callback_query_id: cq.id });
    const chatId = cq.message?.chat.id != null ? String(cq.message.chat.id) : null;
    if (!chatId || !authorized(cq.from?.id)) return;
    if (cq.data === "more") await sendTopStoriesTo(chatId);
  }
}

// ---- webhook registration ----

/** Populate the bot's command menu (the "/" autocomplete + menu button). */
export async function registerCommands(): Promise<void> {
  await tg("setMyCommands", {
    commands: [
      { command: "ask", description: "Ask about recent HN stories" },
      { command: "top", description: "Top Hacker News stories now" },
      { command: "trends", description: "Trends summary of the last few days" },
      { command: "start", description: "Subscribe to the daily digest" },
      { command: "stop", description: "Unsubscribe" },
    ],
  });
  console.log("[telegram] command menu registered");
}

export async function registerWebhook(): Promise<void> {
  if (!telegramEnabled) {
    console.log("[telegram] disabled (no TELEGRAM_BOT_TOKEN)");
    return;
  }
  await registerCommands();
  if (!config.telegram.publicUrl) {
    console.warn("[telegram] PUBLIC_URL not set — skipping webhook registration");
    return;
  }
  const url = `${config.telegram.publicUrl}/telegram/webhook`;
  const res = await tg("setWebhook", {
    url,
    secret_token: webhookSecret,
    allowed_updates: ["message", "callback_query"],
  });
  if (res.ok) console.log(`[telegram] webhook registered at ${url}`);
}
