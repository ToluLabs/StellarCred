import { NextRequest, NextResponse } from 'next/server';
import { getExportJob } from '@/lib/export-jobs';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const job = await getExportJob(id);

    if (!job) {
      return NextResponse.json({ error: 'Export job not found' }, { status: 404 });
    }

    const isExpired = Boolean(job.expiresAt && Date.now() > job.expiresAt);

    return NextResponse.json({
      job: {
        ...job,
        isExpired,
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Failed to fetch export job';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
