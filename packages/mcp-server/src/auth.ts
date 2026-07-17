import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Phase-0 auth (design §4): static bearer token from the environment, compared constant-time.
 * Phase 1 replaces this with Cognito JWT validation (`aws-jwt-verify`) + RFC 9728 metadata routes.
 */
export function checkBearer(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const got = createHash("sha256").update(header.slice("Bearer ".length)).digest();
  const want = createHash("sha256").update(expected).digest();
  return timingSafeEqual(got, want);
}
