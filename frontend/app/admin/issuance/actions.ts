"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { ADMIN_COOKIE, isAdminPageAuthorized } from "@/lib/admin-page-auth";
import { verifyApiKey } from "@/lib/auth";
import { auditLogAppend, auditLogBootstrap, auditLogPersist } from "@/lib/audit-log";
import {
  resolveIssuance,
  retryIssuance,
  type IssuanceQueueRecord,
} from "@/lib/issuance-queue";

export type IssuanceActionResult =
  | { success: true; record: IssuanceQueueRecord }
  | { success: false; error: string };

export async function loginAction(formData: FormData): Promise<void> {
  const key = String(formData.get("key") ?? "");
  if (!verifyApiKey(key, process.env.ADMIN_API_KEY)) return;
  cookies().set(ADMIN_COOKIE, key, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/admin",
    maxAge: 60 * 60 * 8,
  });
  revalidatePath("/admin/issuance");
}

export async function issuanceQueueAction(
  eventId: string,
  action: "retry" | "resolve",
  actor: string,
): Promise<IssuanceActionResult> {
  if (!isAdminPageAuthorized()) return { success: false, error: "unauthorized" };
  const who = actor.trim();
  if (!who) return { success: false, error: "actor is required" };

  const result = action === "retry" ? retryIssuance(eventId) : resolveIssuance(eventId, who);
  if (!result.ok) return { success: false, error: result.error };

  await auditLogBootstrap();
  auditLogAppend({
    timestamp: Date.now(),
    requestId: crypto.randomUUID(),
    issuer: who,
    commitment: eventId,
    adminAction: `issuance_${action}`,
  });
  await auditLogPersist();
  revalidatePath("/admin/issuance");
  return { success: true, record: result.record };
}
