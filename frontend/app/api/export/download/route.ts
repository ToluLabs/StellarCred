import { NextRequest, NextResponse } from 'next/server';
import { verifySecureDownloadToken } from '@/lib/security/secureDownload';
import { getExportJob, getExportArtifact } from '@/lib/export-jobs';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const token = searchParams.get('token');

    if (!token) {
      return NextResponse.json(
        { error: 'Missing required "token" parameter' },
        { status: 400 }
      );
    }

    const verification = verifySecureDownloadToken(token);

    if (!verification.isValid) {
      if (verification.error === 'Token has expired') {
        return NextResponse.json(
          {
            error: 'Download link has expired. Secure download links expire after 5 minutes for privacy and security. Please request a new export from the dashboard.',
            code: 'TOKEN_EXPIRED',
          },
          { status: 410 }
        );
      }

      return NextResponse.json(
        {
          error: verification.error || 'Access denied: Invalid or forged download token.',
          code: 'UNAUTHORIZED_TOKEN',
        },
        { status: 403 }
      );
    }

    const payload = verification.payload;
    if (!payload?.artifactId) {
      return NextResponse.json(
        { error: 'Invalid token payload' },
        { status: 400 }
      );
    }

    const job = await getExportJob(payload.artifactId);
    if (!job) {
      return NextResponse.json(
        { error: 'Export record not found' },
        { status: 404 }
      );
    }

    const artifact = await getExportArtifact(job.id);
    if (!artifact) {
      return NextResponse.json(
        { error: 'Export artifact has expired or was removed.' },
        { status: 404 }
      );
    }

    const format = artifact.format || job.format || 'json';
    const contentType = format === 'json' ? 'application/json' : 'text/csv';
    const filename = `stellarcred-export-${job.scope}-${job.id.slice(0, 10)}.${format}`;

    return new NextResponse(artifact.content, {
      status: 200,
      headers: {
        'Content-Type': `${contentType}; charset=utf-8`,
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Download failed';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
