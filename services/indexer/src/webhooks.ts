import { createHmac } from "crypto";
import { lookup } from "dns/promises";
import { isIP } from "net";
import https from "https";
import type { Db } from "./db";
import type { ClaimLifecycleEvent, WebhookDelivery } from "./db-types";

const DELIVERY_BATCH_SIZE = 50;
const DELIVERY_CONCURRENCY = 5;
const DELIVERY_TIMEOUT_MS = 5_000;
export const MAX_WEBHOOK_DELIVERY_ATTEMPTS = 8;

export interface ClaimWebhookPayload {
  eventId: string;
  type: "claim.revoked" | "claim.expired";
  wallet: string;
  claimType: string;
  expiry: number;
  ledgerSequence: number;
  occurredAt: number;
  reasonCode: string;
}

type WebhookSender = (
  url: string,
  body: string,
  timestamp: string,
  signature: string,
) => Promise<void>;

function isPublicIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b, c] = octets as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 0 || b === 168)) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  return true;
}

function isPublicIpv6(address: string): boolean {
  if (address.includes("%")) return false;
  const halves = address.split("::");
  if (halves.length > 2) return false;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const groups = [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  if (groups.length !== 8 || groups.some((part) => !/^[0-9a-f]{1,4}$/i.test(part))) {
    return false;
  }
  const value = groups.reduce((acc, part) => (acc << 16n) | BigInt(`0x${part}`), 0n);
  const firstThreeBits = value >> 125n;
  const isGlobalUnicast = firstThreeBits === 1n;
  const isDocumentation = (value >> 96n) === 0x20010db8n;
  const is6to4 = (value >> 112n) === 0x2002n;
  return isGlobalUnicast && !isDocumentation && !is6to4;
}

function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
}

async function sendWebhook(
  rawUrl: string,
  body: string,
  timestamp: string,
  signature: string,
): Promise<void> {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("Webhook target must be an HTTPS URL without credentials");
  }
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((entry) => !isPublicAddress(entry.address))) {
    throw new Error("Webhook target must resolve only to public IP addresses");
  }
  const address = addresses[0];
  if (!address) throw new Error("Webhook target DNS lookup returned no address");

  await new Promise<void>((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "X-StellarCred-Timestamp": timestamp,
          "X-StellarCred-Signature": signature,
        },
        timeout: DELIVERY_TIMEOUT_MS,
        lookup: (_hostname, _options, callback) => {
          callback(null, address.address, address.family);
        },
      },
      (response) => {
        response.resume();
        response.on("end", () => {
          const status = response.statusCode ?? 0;
          if (status >= 200 && status < 300) resolve();
          else reject(new Error(`Webhook endpoint responded with HTTP ${status}`));
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("Webhook request timed out")));
    req.on("error", reject);
    req.end(body);
  });
}

function eventPayload(delivery: WebhookDelivery): ClaimWebhookPayload {
  return {
    eventId: delivery.event_id,
    type: delivery.type === "revoked" ? "claim.revoked" : "claim.expired",
    wallet: delivery.wallet,
    claimType: delivery.credential_type,
    expiry: delivery.expiry,
    ledgerSequence: delivery.ledger_sequence,
    occurredAt: delivery.occurred_at,
    reasonCode: delivery.reason_code,
  };
}

export function createWebhookDispatcher(
  db: Db,
  signingSecret: string,
  options: { send?: WebhookSender; now?: () => number } = {},
) {
  const send = options.send ?? sendWebhook;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));

  async function enqueueExpiredClaims(): Promise<number> {
    const timestamp = now();
    const expired = await db.expiredActiveClaims(timestamp);
    for (const claim of expired) {
      const event: ClaimLifecycleEvent = {
        event_id: `expired:${claim.wallet}:${claim.credential_type}:${claim.expiry}:${claim.ledger_sequence}`,
        type: "expired",
        wallet: claim.wallet,
        credential_type: claim.credential_type,
        expiry: claim.expiry,
        ledger_sequence: claim.ledger_sequence,
        occurred_at: claim.expiry,
        reason_code: "credential_expired",
      };
      await db.enqueueWebhookEvent(event);
    }
    return expired.length;
  }

  async function dispatchPending(): Promise<number> {
    if (signingSecret.length < 32) {
      throw new Error("WEBHOOK_SIGNING_SECRET must contain at least 32 characters");
    }

    const timestamp = now();
    const deliveries = await db.pendingWebhookDeliveries(
      timestamp,
      DELIVERY_BATCH_SIZE,
      MAX_WEBHOOK_DELIVERY_ATTEMPTS,
    );
    for (let start = 0; start < deliveries.length; start += DELIVERY_CONCURRENCY) {
      const batch = deliveries.slice(start, start + DELIVERY_CONCURRENCY);
      await Promise.all(batch.map(async (delivery) => {
        const payload = eventPayload(delivery);
        const body = JSON.stringify(payload);
        const signedContent = `${timestamp}.${body}`;
        const signature = `sha256=${createHmac("sha256", signingSecret)
          .update(signedContent)
          .digest("hex")}`;
        const attempts = delivery.attempts + 1;

        try {
          await send(delivery.target_url, body, String(timestamp), signature);
          await db.updateWebhookDelivery(delivery.id, {
            attempts,
            nextAttemptAt: timestamp,
            deliveredAt: timestamp,
            lastError: null,
          });
        } catch (error) {
          const delaySeconds = Math.min(3600, 5 * 2 ** (attempts - 1));
          await db.updateWebhookDelivery(delivery.id, {
            attempts,
            nextAttemptAt: timestamp + delaySeconds,
            deliveredAt: null,
            lastError: (error instanceof Error ? error.message : String(error)).slice(0, 500),
          });
        }
      }));
    }
    return deliveries.length;
  }

  return { enqueueExpiredClaims, dispatchPending };
}
