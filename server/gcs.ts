/**
 * Google Cloud Storage helpers.
 * Buckets:
 *   cic-authoritative-case-files  — permanent original uploads
 *   cic-docai-staging-inputs      — ephemeral ≤500-page chunks
 *   cic-docai-staging-outputs     — ephemeral DocAI JSON outputs
 */
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { getStorage, getEnv } from './config.js';

export const BUCKET_AUTH    = () => getEnv('GCS_AUTHORITATIVE_BUCKET') || 'cic-authoritative-case-files';
export const BUCKET_STAGING = () => getEnv('GCS_STAGING_INPUT_BUCKET') || 'cic-docai-staging-inputs';
export const BUCKET_OUTPUT  = () => getEnv('GCS_STAGING_OUTPUT_BUCKET') || 'cic-docai-staging-outputs';

/** Upload a local file to GCS and return the gs:// URI. */
export async function uploadFile(localPath: string, bucket: string, destPath: string): Promise<string> {
  await getStorage().bucket(bucket).upload(localPath, { destination: destPath });
  return `gs://${bucket}/${destPath}`;
}

/** Upload a Buffer directly to GCS. */
export async function uploadBuffer(buf: Buffer, bucket: string, destPath: string, contentType = 'application/octet-stream'): Promise<string> {
  const file = getStorage().bucket(bucket).file(destPath);
  await file.save(buf, { contentType });
  return `gs://${bucket}/${destPath}`;
}

/** Download a GCS object to a local file path. */
export async function downloadFile(bucket: string, srcPath: string, localDestPath: string): Promise<void> {
  const readStream = getStorage().bucket(bucket).file(srcPath).createReadStream();
  const writeStream = createWriteStream(localDestPath);
  await pipeline(readStream, writeStream);
}

/** Delete a single GCS object. */
export async function deleteObject(bucket: string, destPath: string): Promise<void> {
  try {
    await getStorage().bucket(bucket).file(destPath).delete();
  } catch (e: any) {
    if (e.code !== 404) throw e;
  }
}

/** Delete all objects in a GCS prefix (folder). */
export async function deletePrefix(bucket: string, prefix: string): Promise<number> {
  const [files] = await getStorage().bucket(bucket).getFiles({ prefix });
  await Promise.all(files.map(f => f.delete().catch(() => {})));
  return files.length;
}

/** Generate a short-lived signed URL for reading a GCS object. */
export async function signedReadUrl(bucket: string, destPath: string, expiresMinutes = 60): Promise<string> {
  const [url] = await getStorage().bucket(bucket).file(destPath).getSignedUrl({
    action: 'read',
    expires: Date.now() + expiresMinutes * 60 * 1000,
  });
  return url;
}

/** Get total bytes used across a bucket. */
export async function getBucketUsageBytes(bucket: string): Promise<number> {
  try {
    const [files] = await getStorage().bucket(bucket).getFiles();
    return files.reduce((sum, f) => sum + parseInt((f.metadata as any).size || '0', 10), 0);
  } catch {
    return 0;
  }
}

/** List all objects in a bucket prefix with metadata. */
export async function listObjects(bucket: string, prefix?: string) {
  const [files] = await getStorage().bucket(bucket).getFiles(prefix ? { prefix } : {});
  return files.map(f => ({
    name: f.name,
    size: parseInt((f.metadata as any).size || '0', 10),
    updated: (f.metadata as any).updated,
  }));
}
