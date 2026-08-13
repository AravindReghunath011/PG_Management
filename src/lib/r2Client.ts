import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const REQUIRED_ENV_VARS = [
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET_NAME',
  'R2_BUCKET_URL',
] as const;

export function assertR2ConfigPresent(): void {
  const missing = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required R2 environment variable(s): ${missing.join(', ')}`
    );
  }
}

export function createR2Client(): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
    },
  });
}

// Fail fast at boot rather than failing silently per-request in production.
if (process.env.NODE_ENV !== 'test') {
  assertR2ConfigPresent();
}

export const r2Client = createR2Client();

export async function uploadBufferToR2(
  client: S3Client,
  params: { bucket: string; key: string; body: Buffer; contentType: string }
): Promise<void> {
  await client.send(
    new PutObjectCommand({
      Bucket: params.bucket,
      Key: params.key,
      Body: params.body,
      ContentType: params.contentType,
    })
  );
}

// Stable, content-addressed key (not a random UUID) so a retried upload
// overwrites the same object instead of orphaning the previous one.
export function buildKycObjectKey(residentId: string, ext: string): string {
  return `kyc/${residentId}${ext}`;
}

export function buildPublicUrl(key: string): string {
  const base = (process.env.R2_BUCKET_URL || '').replace(/\/+$/, '');
  return `${base}/${key}`;
}
