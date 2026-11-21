import { getSharedStore } from './shared-store';
import { generateSecureDownloadUrl } from './security/secureDownload';
import { EXPORT_SCHEMA_VERSION, type ExportArtifactV1 } from './export-schema';

export type ExportScope = 'credentials' | 'proofs' | 'activity' | 'full' | 'admin_audit';
export type ExportFormat = 'json' | 'csv';
export type ExportStatus = 'pending' | 'processing' | 'ready' | 'failed';

export interface ExportJob {
  id: string;
  tenantId: string;
  userAddress: string;
  scope: ExportScope;
  format: ExportFormat;
  status: ExportStatus;
  progress: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  expiresAt?: number;
  downloadUrl?: string;
  downloadToken?: string;
  error?: string;
  fileSize?: number;
}

export interface ScopeDefinition {
  id: ExportScope;
  label: string;
  description: string;
  requiresAdmin: boolean;
}

export const EXPORT_SCOPES: ScopeDefinition[] = [
  {
    id: 'credentials',
    label: 'Credentials',
    description: 'Verified credentials, claims, issuer identifiers, and commitments.',
    requiresAdmin: false,
  },
  {
    id: 'proofs',
    label: 'Proof History',
    description: 'Zero-knowledge proof verification records and submission hashes.',
    requiresAdmin: false,
  },
  {
    id: 'activity',
    label: 'Activity & Audit',
    description: 'Timeline audit events, timestamps, and on-chain verification logs.',
    requiresAdmin: false,
  },
  {
    id: 'full',
    label: 'Complete Archive',
    description: 'All your StellarCred data: credentials, proofs, timeline events, and settings.',
    requiresAdmin: false,
  },
  {
    id: 'admin_audit',
    label: 'Admin Audit Log',
    description: 'System-wide governance, operator actions, and tenant audit trails.',
    requiresAdmin: true,
  },
];

export function getAllowedScopes(isAdmin: boolean = false): ExportScope[] {
  return EXPORT_SCOPES.filter((s) => !s.requiresAdmin || isAdmin).map((s) => s.id);
}

export function isScopeAllowed(scope: string, isAdmin: boolean = false): boolean {
  const allowed = getAllowedScopes(isAdmin);
  return allowed.includes(scope as ExportScope);
}

// In-memory fallback if shared store fails
const memoryJobIndex = new Map<string, string[]>();
const memoryJobMap = new Map<string, ExportJob>();
const memoryArtifactMap = new Map<string, { content: string; format: ExportFormat; expiresAt: number }>();

function generateId(prefix = 'exp'): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function createExportJob(params: {
  userAddress: string;
  tenantId?: string;
  scope: ExportScope;
  format: ExportFormat;
  isAdmin?: boolean;
}): Promise<ExportJob> {
  const { userAddress, tenantId = 'default', scope, format, isAdmin = false } = params;

  if (!isScopeAllowed(scope, isAdmin)) {
    throw new Error(`Unauthorized scope: "${scope}". User does not have permission for this scope.`);
  }

  const id = generateId('job');
  const now = Date.now();

  const job: ExportJob = {
    id,
    tenantId,
    userAddress,
    scope,
    format,
    status: 'pending',
    progress: 0,
    createdAt: now,
    updatedAt: now,
  };

  const store = getSharedStore();
  const jobKey = `export:job:${id}`;
  const userIndexKey = `export:user:${userAddress}`;

  try {
    await store.set(jobKey, JSON.stringify(job), 86400); // 24hr TTL
    const existingIndexStr = await store.get(userIndexKey);
    const existingList: string[] = existingIndexStr ? JSON.parse(existingIndexStr) : [];
    if (!existingList.includes(id)) {
      existingList.unshift(id);
      await store.set(userIndexKey, JSON.stringify(existingList.slice(0, 50)), 86400 * 7);
    }
  } catch {
    // Memory fallback
    memoryJobMap.set(id, job);
    const list = memoryJobIndex.get(userAddress) || [];
    list.unshift(id);
    memoryJobIndex.set(userAddress, list.slice(0, 50));
  }

  // Trigger async background processing simulation
  void processExportJob(id);

  return job;
}

export async function getExportJob(id: string): Promise<ExportJob | null> {
  const store = getSharedStore();
  try {
    const raw = await store.get(`export:job:${id}`);
    if (raw) return JSON.parse(raw);
  } catch {
    // ignore
  }
  return memoryJobMap.get(id) || null;
}

export async function listUserExportJobs(userAddress: string): Promise<ExportJob[]> {
  const store = getSharedStore();
  let ids: string[] = [];
  try {
    const raw = await store.get(`export:user:${userAddress}`);
    if (raw) ids = JSON.parse(raw);
  } catch {
    ids = memoryJobIndex.get(userAddress) || [];
  }

  if (ids.length === 0) {
    ids = memoryJobIndex.get(userAddress) || [];
  }

  const jobs: ExportJob[] = [];
  for (const id of ids) {
    const job = await getExportJob(id);
    if (job) {
      // Check if download link is expired
      if (job.status === 'ready' && job.expiresAt && Date.now() > job.expiresAt) {
        // Leave status as ready, but download links will be invalidated
      }
      jobs.push(job);
    }
  }

  return jobs.sort((a, b) => b.createdAt - a.createdAt);
}

export async function updateExportJob(job: ExportJob): Promise<void> {
  job.updatedAt = Date.now();
  const store = getSharedStore();
  try {
    await store.set(`export:job:${job.id}`, JSON.stringify(job), 86400);
  } catch {
    // ignore
  }
  memoryJobMap.set(job.id, job);
}

export async function saveExportArtifact(
  jobId: string,
  content: string,
  format: ExportFormat,
  expiresAt: number
): Promise<void> {
  const ttlSeconds = Math.max(60, Math.ceil((expiresAt - Date.now()) / 1000));
  const store = getSharedStore();
  try {
    await store.set(`export:artifact:${jobId}`, content, ttlSeconds);
  } catch {
    // ignore
  }
  memoryArtifactMap.set(jobId, { content, format, expiresAt });
}

export async function getExportArtifact(
  jobId: string
): Promise<{ content: string; format: ExportFormat } | null> {
  const store = getSharedStore();
  try {
    const content = await store.get(`export:artifact:${jobId}`);
    if (content) {
      const job = await getExportJob(jobId);
      return { content, format: job?.format || 'json' };
    }
  } catch {
    // ignore
  }

  const mem = memoryArtifactMap.get(jobId);
  if (mem) {
    if (Date.now() > mem.expiresAt) {
      memoryArtifactMap.delete(jobId);
      return null;
    }
    return { content: mem.content, format: mem.format };
  }

  return null;
}

/**
 * Simulates async job processing: transitions pending -> processing -> ready,
 * produces realistic schema v1 export data, and attaches an expiring secure download token.
 */
async function processExportJob(id: string): Promise<void> {
  const job = await getExportJob(id);
  if (!job) return;

  // Step 1: Processing
  job.status = 'processing';
  job.progress = 30;
  await updateExportJob(job);

  // Small delay for deterministic async simulation
  await new Promise((resolve) => setTimeout(resolve, 600));

  job.progress = 75;
  await updateExportJob(job);

  await new Promise((resolve) => setTimeout(resolve, 400));

  // Generate payload
  const generatedAt = new Date().toISOString();
  let content = '';

  if (job.format === 'json') {
    const artifact: ExportArtifactV1 = {
      schemaVersion: EXPORT_SCHEMA_VERSION,
      generation: {
        generatedAt,
        generator: 'stellarcred-dashboard-exporter@0.1.0',
      },
      count: 2,
      entries: [
        {
          claimType: job.scope === 'proofs' ? 'membership' : 'age_above_18',
          verifiedAt: Math.floor(Date.now() / 1000) - 86400,
          expiry: Math.floor(Date.now() / 1000) + 86400 * 30,
          txHash: '0x3a4f6d8920194827102938475620192837465102938475610293847561029384',
          issuer: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBHF2',
          source: `export:${job.scope}`,
        },
        {
          claimType: 'stellar_account_verified',
          verifiedAt: Math.floor(Date.now() / 1000) - 43200,
          expiry: 0,
          txHash: '0x8b2e1c9482910482719284756102938475610293847561029384756102938475',
          issuer: 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVGAS',
          source: `export:${job.scope}`,
        },
      ],
    };
    content = JSON.stringify(artifact, null, 2);
  } else {
    // CSV format
    const rows = [
      ['claim_type', 'verified_at', 'expiry', 'tx_hash', 'issuer', 'scope'],
      [
        'age_above_18',
        new Date(Date.now() - 86400000).toISOString(),
        new Date(Date.now() + 86400000 * 30).toISOString(),
        '0x3a4f6d8920194827102938475620192837465102938475610293847561029384',
        'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBHF2',
        job.scope,
      ],
      [
        'stellar_account_verified',
        new Date(Date.now() - 43200000).toISOString(),
        '',
        '0x8b2e1c9482910482719284756102938475610293847561029384756102938475',
        'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVGAS',
        job.scope,
      ],
    ];
    content = rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(',')).join('\n');
  }

  // Generate expiring secure download token (valid for 300 seconds = 5 minutes)
  const { url, token, expiresAt } = generateSecureDownloadUrl(
    job.id,
    job.tenantId,
    300,
    '',
    job.scope,
    job.userAddress
  );

  await saveExportArtifact(job.id, content, job.format, expiresAt);

  job.status = 'ready';
  job.progress = 100;
  job.completedAt = Date.now();
  job.expiresAt = expiresAt;
  job.downloadUrl = url;
  job.downloadToken = token;
  job.fileSize = Buffer.byteLength(content, 'utf8');

  await updateExportJob(job);
}
