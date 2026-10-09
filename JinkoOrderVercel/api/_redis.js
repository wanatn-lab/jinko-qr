// Shared Redis client for all API routes.
// Works with either naming convention Vercel Storage integrations use:
//   - Vercel-managed "Upstash for Redis" (Marketplace): usually KV_REST_API_URL / KV_REST_API_TOKEN
//   - A raw Upstash Redis database connected directly: UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
import { Redis } from "@upstash/redis";

// Preview deployments (test links from branches / pull requests) must NEVER touch the real
// shop data. In preview we only accept a separate test database (variables with the
// PREVIEW_ prefix); if it is missing we deliberately connect to nothing instead of falling
// back to the real database.
const isPreview = process.env.VERCEL_ENV === "preview";
const url = isPreview
  ? process.env.PREVIEW_KV_REST_API_URL || process.env.PREVIEW_UPSTASH_REDIS_REST_URL
  : process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const token = isPreview
  ? process.env.PREVIEW_KV_REST_API_TOKEN || process.env.PREVIEW_UPSTASH_REDIS_REST_TOKEN
  : process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

if (!url || !token) {
  // Don't throw at import time (breaks the whole function bundle) — throw
  // lazily so the error message is useful when an API route is actually hit.
  console.warn(
    (isPreview ? "[api] PREVIEW deployment: set PREVIEW_KV_REST_API_URL / PREVIEW_KV_REST_API_TOKEN (a separate test database). " : "") +
    "[api] Missing Redis env vars. Add the 'Upstash for Redis' storage integration " +
    "to this Vercel project (Storage tab) so KV_REST_API_URL / KV_REST_API_TOKEN are set."
  );
}

export const redis = new Redis({ url, token });
