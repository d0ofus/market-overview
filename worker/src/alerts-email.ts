import PostalMime from "postal-mime";
import type { InboundEmailPayload } from "./alerts-types";
import { ingestTradingViewAlertEmail } from "./alerts-service";
import type { Env } from "./types";

type InboundMessage = {
  from: string;
  to: string;
  raw: ReadableStream<Uint8Array> | ArrayBuffer;
  headers: Headers;
  setReject(reason: string): void;
};

const DEFAULT_ALLOWED_FROM = "tradingview.com";

function normalizeAllowedFrom(env: Env): string[] {
  const raw = (env.ALERTS_EMAIL_ALLOWED_FROM ?? DEFAULT_ALLOWED_FROM).trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
}

export function senderAllowed(fromAddress: string, env: Env): boolean {
  const allowlist = normalizeAllowedFrom(env);
  if (allowlist.length === 0) return true;
  const normalized = fromAddress.trim().toLowerCase();
  return allowlist.some((entry) => normalized.includes(entry));
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

async function parseInboundMessage(message: InboundMessage): Promise<InboundEmailPayload> {
  const parser = new PostalMime();
  const parsed = await parser.parse(message.raw);
  const parsedHeaders = headersToObject(message.headers);

  return {
    messageId:
      (typeof parsed.messageId === "string" && parsed.messageId.trim()) ||
      parsedHeaders["message-id"] ||
      null,
    subject:
      (typeof parsed.subject === "string" && parsed.subject.trim()) ||
      parsedHeaders["subject"] ||
      null,
    from: message.from || parsedHeaders["from"] || null,
    receivedAt: parsedHeaders["date"] || new Date().toISOString(),
    text: typeof parsed.text === "string" ? parsed.text : null,
    html: typeof parsed.html === "string" ? parsed.html : null,
    headers: parsedHeaders,
    rawPayload: {
      subject: parsed.subject ?? null,
      date: parsed.date ?? null,
      from: parsed.from ?? null,
      to: parsed.to ?? null,
      messageId: parsed.messageId ?? null,
    },
    sourceMailbox: message.to || parsedHeaders["to"] || null,
  };
}

export async function handleInboundTradingViewEmail(message: InboundMessage, env: Env): Promise<void> {
  if (!senderAllowed(message.from, env)) {
    message.setReject("Sender is not allowed for alerts mailbox.");
    return;
  }

  try {
    const payload = await parseInboundMessage(message);
    const result = await ingestTradingViewAlertEmail(env, payload);
    if (result.status === "parse_failed") {
      console.warn("alerts email parse failed", {
        messageId: result.messageId,
        error: result.error,
      });
    }
  } catch (error) {
    console.error("alerts inbound email handling failed", error);
    message.setReject("Failed to parse or ingest email.");
  }
}
