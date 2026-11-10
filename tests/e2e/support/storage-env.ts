// File storage (S15) goes to the local S3 stand-in (tools/s3-stand-in), never a real bucket.
// Synthetic credentials, valid only against the stand-in, which keeps objects in memory. Shared by
// the web server (playwright.config.ts) and the local job runner (support/jobs.ts, S39 exports).
const s3Port = Number(process.env.PLAYWRIGHT_S3_PORT ?? 54390);

export const e2eS3Port = s3Port;

export const e2eStorageEnv = {
  STORAGE_DRIVER: "s3",
  STORAGE_S3_ENDPOINT: `http://127.0.0.1:${String(s3Port)}`,
  STORAGE_S3_REGION: "auto",
  STORAGE_S3_BUCKET: "madeora-e2e",
  STORAGE_S3_ACCESS_KEY_ID: "E2eSyntheticAccessKey",
  STORAGE_S3_SECRET_ACCESS_KEY: "E2eSyntheticSecretAccessKey0123456789",
} as const;
