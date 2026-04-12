import { createMiddleware } from "hono/factory";

type Bindings = {
  RATE_LIMIT_KV: KVNamespace;
  GITHUB_TOKEN: string;
  LESSON_WEBHOOK_SECRET: string;
  ENVIRONMENT: string;
};

const WINDOW_SEC = 60;
const MAX_REQUESTS = 10;

export const rateLimit = createMiddleware<{ Bindings: Bindings }>(async (c, next) => {
  const kv: KVNamespace | undefined = (c.env as Bindings)?.RATE_LIMIT_KV;

  // Fallback: no KV bound (local dev) — allow through
  if (!kv) {
    await next();
    return;
  }

  const ip = c.req.header("cf-connecting-ip") // Cloudflare sets this reliably
    ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
    ?? "unknown";

  const key = `rl:${ip}`;
  const raw = await kv.get(key);
  const count = raw ? parseInt(raw, 10) : 0;

  if (count >= MAX_REQUESTS) {
    c.header("Retry-After", String(WINDOW_SEC));
    return c.json({ error: "Rate limited. Try again later." }, 429);
  }

  // Increment; set TTL only on first write so window is fixed, not sliding
  if (count === 0) {
    await kv.put(key, "1", { expirationTtl: WINDOW_SEC });
  } else {
    // preserve existing TTL by not passing expirationTtl
    await kv.put(key, String(count + 1));
  }

  await next();
});
