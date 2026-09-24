export interface SubmissionRecord {
  credentialType: string;
  timestamp: number;
  txHash: string;
  status: "confirmed" | "pending" | "failed";
}

const STORAGE_KEY = "stellarcred_submissions";

export function saveSubmission(record: SubmissionRecord): void {
  if (typeof window === "undefined") return;
  const history = getSubmissions();
  history.unshift(record);
  const trimmed = history.slice(0, 50);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // Silently fail
  }
}

export function getSubmissions(): SubmissionRecord[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as SubmissionRecord[];
  } catch {
    return [];
  }
}

