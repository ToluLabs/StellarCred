// frontend/lib/admin-page-auth.ts
//
// Server-side admin gate for admin pages and server actions (#850).
// Accepts the ADMIN_API_KEY as a Bearer header (API/proxy use) or as the
// httpOnly `admin_session` cookie set by the login action.

import { cookies, headers } from "next/headers";
import { verifyApiKey } from "@/lib/auth";

export const ADMIN_COOKIE = "admin_session";

export function isAdminPageAuthorized(): boolean {
  const configured = process.env.ADMIN_API_KEY;
  const bearer = headers().get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  if (verifyApiKey(bearer, configured)) return true;
  return verifyApiKey(cookies().get(ADMIN_COOKIE)?.value, configured);
}
