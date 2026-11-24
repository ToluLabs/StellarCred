import { NextRequest, NextResponse } from 'next/server';
import {
  createExportJob,
  listUserExportJobs,
  getAllowedScopes,
  isScopeAllowed,
  type ExportScope,
  type ExportFormat,
} from '@/lib/export-jobs';

function getUserContext(req: NextRequest) {
  const addressHeader = req.headers.get('x-user-address');
  const authHeader = req.headers.get('authorization');
  const roleHeader = req.headers.get('x-user-role');

  const userAddress = addressHeader || 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBHF2';
  const isAdmin = roleHeader === 'admin' || authHeader?.toLowerCase().includes('admin');

  return { userAddress, isAdmin };
}

export async function GET(req: NextRequest) {
  try {
    const { userAddress, isAdmin } = getUserContext(req);
    const jobs = await listUserExportJobs(userAddress);
    const allowedScopes = getAllowedScopes(isAdmin);

    return NextResponse.json({
      jobs,
      allowedScopes,
      userAddress,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Failed to fetch export jobs';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const { userAddress, isAdmin } = getUserContext(req);

    const body = await req.json().catch(() => ({}));
    const { scope, format = 'json', tenantId = 'default' } = body as {
      scope?: string;
      format?: string;
      tenantId?: string;
    };

    if (!scope) {
      return NextResponse.json(
        { error: 'Missing required field: "scope"' },
        { status: 400 }
      );
    }

    if (!['json', 'csv'].includes(format)) {
      return NextResponse.json(
        { error: 'Invalid format. Allowed formats are "json" and "csv"' },
        { status: 400 }
      );
    }

    // Authorization check: Verify user is permitted to request this scope
    if (!isScopeAllowed(scope, isAdmin)) {
      return NextResponse.json(
        {
          error: `Forbidden: You do not have permission to export scope "${scope}".`,
          allowedScopes: getAllowedScopes(isAdmin),
        },
        { status: 403 }
      );
    }

    const job = await createExportJob({
      userAddress,
      tenantId,
      scope: scope as ExportScope,
      format: format as ExportFormat,
      isAdmin,
    });

    return NextResponse.json({ job }, { status: 201 });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Failed to create export job';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
