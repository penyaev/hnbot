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

/** Send the trends summary to a chat. */
export async function sendTrendsTo(chatId: string): Promise<void> {
  try {
    const { summary, days } = await getSummary({});
    const header = `📊 <b>HN trends — last ${days} days</b>`;
    const html = mdToHtml(summary);
    const chunks = chunk(html);
    await sendText(chatId, `${header}\n\n${chunks[0]}`);
    for (const part of chunks.slice(1)) await sendText(chatId, part);
  } catch (e) {
    console.error("[telegram] trends send failed:", e);
    await sendText(chatId, "⚠️ Couldn't generate the trends summary right now.");
  }
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
  "Tap <b>More stories</b> under any digest to pull the next batch.";

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
    const cmd = (text ?? "").trim().split(/\s+/)[0].toLowerCase();
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
      default:
        await sendText(
          chatId,
          "Commands: /start, /top, /trends, /stop.\nTap <b>More stories</b> under a digest for the next batch.",
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

export async function registerWebhook(): Promise<void> {
  if (!telegramEnabled) {
    console.log("[telegram] disabled (no TELEGRAM_BOT_TOKEN)");
    return;
  }
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
