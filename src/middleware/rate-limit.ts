import { createMiddleware } from "hono/factory";

// In-memory rate limiter (for Cloudflare Workers, use KV binding in production)
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

const WINDOW_MS = 60_000; // 1 minute
const MAX_REQUESTS = 10; // per window

export const rateLimit = createMiddleware(async (c, next) => {
  // Rate limit by API key if available, otherwise by IP
  const authHeader = c.req.header("Authorization");
  let key: string;

  if (authHeader?.startsWith("Bearer nk_")) {
    key = `key:${authHeader.replace("Bearer ", "")}`;
  } else {
    key = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  }

  const now = Date.now();
  const entry = rateLimitMap.get(key);

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + WINDOW_MS });
    await next();
    return;
  }

  if (entry.count >= MAX_REQUESTS) {
    c.header("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)));
    return c.json({ error: "Rate limited. Try again later." }, 429);
  }

  entry.count++;
  await next();
});
