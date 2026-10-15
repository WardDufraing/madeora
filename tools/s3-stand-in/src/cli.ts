// Usage: pnpm --filter @madeora/s3-stand-in start
//
// Runs the local S3 stand-in (server.ts) for development and the browser tests, with the same
// STORAGE_S3_* values the web app and the jobs use (apps/web/.env.example). Objects live in memory
// and vanish when it stops. Refuses to listen anywhere but this machine.
import { parseStorageEnv, storageConfigFromEnv } from "@madeora/storage";

import { startS3StandIn } from "./server.ts";

const config = storageConfigFromEnv(parseStorageEnv(process.env));
if (!config) {
  console.error("S3 stand-in: set STORAGE_DRIVER=s3 and the STORAGE_S3_* values first.");
  process.exit(2);
}
const endpoint = new URL(config.endpoint);
if (endpoint.hostname !== "127.0.0.1" || endpoint.protocol !== "http:") {
  console.error("S3 stand-in: STORAGE_S3_ENDPOINT must be http://127.0.0.1:<port>.");
  process.exit(2);
}

const standIn = await startS3StandIn({
  port: Number(endpoint.port || "80"),
  bucket: config.bucket,
  credentials: {
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    region: config.region,
  },
  allowedOrigin: new URL(process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").origin,
});
console.log(`S3 stand-in: listening on ${standIn.url} (bucket ${config.bucket}); Ctrl-C to stop.`);
