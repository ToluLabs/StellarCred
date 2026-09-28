/**
 * Apps gallery submission and review store (#433).
 *
 * Provides validation, storage, and review/approval workflow for third-party
 * app submissions. Works with the services/indexer HTTP API when available,
 * and seamlessly falls back to the shared Key-Value store when running
 * standalone or in serverless environments.
 */

import { getSharedStore } from "./shared-store";

export const VALID_CLAIM_TYPES = [
  "kyc",
  "age",
  "jurisdiction",
  "income",
  "funds",
  "accreditation",
  "employment",
] as const;

export type ValidClaimType = (typeof VALID_CLAIM_TYPES)[number];

export const MAX_APP_NAME = 120;
export const MAX_DESCRIPTION = 2000;
export const MAX_CLAIMS = 10;
export const MAX_CONTACT_EMAIL = 254;

export interface AppSubmissionInput {
  appName: string;
  description: string;
  requiredClaims: string[];
  verifyUrl: string;
  contactEmail: string;
}

export interface StoredAppSubmission {
  id: number;
  app_name: string;
  description: string;
  required_claims: string; // JSON array string
  verify_url: string;
  contact_email: string;
  status: "pending" | "approved" | "rejected";
  created_at: string;
  reviewed_at: string | null;
}

// In-process fallback cache for standalone frontend
const memorySubmissions = new Map<number, StoredAppSubmission>();

export function validateUrl(url: string): boolean {
  if (!url || typeof url !== "string") return false;
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function validateEmail(email: string): boolean {
  if (!email || typeof email !== "string") return false;
  const trimmed = email.trim();
  if (trimmed.length > MAX_CONTACT_EMAIL) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
}

export function validateSubmission(input: Partial<AppSubmissionInput>): {
  valid: boolean;
  errors: Record<string, string>;
} {
  const errors: Record<string, string> = {};

  if (!input.appName || typeof input.appName !== "string" || !input.appName.trim()) {
    errors.appName = "App name is required";
  } else if (input.appName.trim().length > MAX_APP_NAME) {
    errors.appName = `App name must be at most ${MAX_APP_NAME} characters`;
  }

  if (!input.description || typeof input.description !== "string" || !input.description.trim()) {
    errors.description = "Description is required";
  } else if (input.description.trim().length > MAX_DESCRIPTION) {
    errors.description = `Description must be at most ${MAX_DESCRIPTION} characters`;
  }

  if (!Array.isArray(input.requiredClaims) || input.requiredClaims.length === 0) {
    errors.requiredClaims = "At least one required claim type must be selected";
  } else if (input.requiredClaims.length > MAX_CLAIMS) {
    errors.requiredClaims = `At most ${MAX_CLAIMS} claim types allowed`;
  } else {
    for (const c of input.requiredClaims) {
      if (typeof c !== "string" || !VALID_CLAIM_TYPES.includes(c.trim() as ValidClaimType)) {
        errors.requiredClaims = `Invalid claim type: "${c}". Valid types: ${VALID_CLAIM_TYPES.join(", ")}`;
        break;
      }
    }
  }

  if (!input.verifyUrl || typeof input.verifyUrl !== "string" || !input.verifyUrl.trim()) {
    errors.verifyUrl = "Verify URL is required";
  } else if (!validateUrl(input.verifyUrl)) {
    errors.verifyUrl = "Verify URL must be a valid http or https URL";
  }

  if (!input.contactEmail || typeof input.contactEmail !== "string" || !input.contactEmail.trim()) {
    errors.contactEmail = "Contact email is required";
  } else if (!validateEmail(input.contactEmail)) {
    errors.contactEmail = "Enter a valid email address";
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
  };
}

/**
 * Submit an app integration for review.
 */
export async function submitApp(
  input: AppSubmissionInput,
  indexerUrl = process.env.INDEXER_URL ?? "http://localhost:3001",
): Promise<{ id: number; status: "pending" }> {
  const validation = validateSubmission(input);
  if (!validation.valid) {
    const firstError = Object.values(validation.errors)[0];
    throw new Error(firstError);
  }

  // Attempt indexer submission if available
  try {
    const res = await fetch(`${indexerUrl}/apps/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appName: input.appName.trim(),
        description: input.description.trim(),
        requiredClaims: input.requiredClaims.map((c) => c.trim()),
        verifyUrl: input.verifyUrl.trim(),
        contactEmail: input.contactEmail.trim(),
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (res.ok) {
      const data = await res.json();
      return { id: data.id, status: "pending" };
    }
  } catch {
    // Indexer unreachable — proceed to local/shared store fallback
  }

  // Local/shared store fallback
  const id = Date.now();
  const submission: StoredAppSubmission = {
    id,
    app_name: input.appName.trim(),
    description: input.description.trim(),
    required_claims: JSON.stringify(input.requiredClaims.map((c) => c.trim())),
    verify_url: input.verifyUrl.trim(),
    contact_email: input.contactEmail.trim(),
    status: "pending",
    created_at: new Date().toISOString(),
    reviewed_at: null,
  };

  memorySubmissions.set(id, submission);

  const sharedStore = getSharedStore();
  await sharedStore.set(`app:submission:${id}`, JSON.stringify(submission)).catch(() => null);

  return { id, status: "pending" };
}

/**
 * Review an app submission (approve or reject).
 */
export async function reviewApp(
  id: number,
  status: "approved" | "rejected" | "pending",
  indexerUrl = process.env.INDEXER_URL ?? "http://localhost:3001",
): Promise<StoredAppSubmission | null> {
  // Try updating indexer if reachable
  try {
    const res = await fetch(`${indexerUrl}/apps/${id}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.app) return data.app;
    }
  } catch {
    // Fall back to local/shared store
  }

  // Update in memory/shared store
  let submission = memorySubmissions.get(id);
  const sharedStore = getSharedStore();

  if (!submission) {
    const raw = await sharedStore.get(`app:submission:${id}`).catch(() => null);
    if (raw) {
      submission = JSON.parse(raw);
    }
  }

  if (!submission) return null;

  submission.status = status;
  submission.reviewed_at = new Date().toISOString();
  memorySubmissions.set(id, submission);

  await sharedStore.set(`app:submission:${id}`, JSON.stringify(submission)).catch(() => null);

  return submission;
}

/**
 * List all approved app submissions.
 */
export async function listApprovedApps(
  indexerUrl = process.env.INDEXER_URL ?? "http://localhost:3001",
): Promise<StoredAppSubmission[]> {
  const approvedMap = new Map<string, StoredAppSubmission>();

  // 1. Fetch approved from indexer
  try {
    const res = await fetch(`${indexerUrl}/apps`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.apps)) {
        for (const app of data.apps) {
          approvedMap.set(String(app.id), app);
        }
      }
    }
  } catch {
    // Indexer unreachable
  }

  // 2. Fetch approved from local store
  for (const app of memorySubmissions.values()) {
    if (app.status === "approved") {
      approvedMap.set(String(app.id), app);
    }
  }

  return Array.from(approvedMap.values());
}

/**
 * Get a single app submission by ID.
 */
export async function getAppSubmission(
  id: number,
  indexerUrl = process.env.INDEXER_URL ?? "http://localhost:3001",
): Promise<StoredAppSubmission | null> {
  try {
    const res = await fetch(`${indexerUrl}/apps/${id}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.app) return data.app;
    }
  } catch {
    // Indexer unreachable
  }

  const local = memorySubmissions.get(id);
  if (local) return local;

  const sharedStore = getSharedStore();
  const raw = await sharedStore.get(`app:submission:${id}`).catch(() => null);
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Clear local submissions for testing.
 */
export function __resetAppSubmissionsForTesting(): void {
  memorySubmissions.clear();
}
