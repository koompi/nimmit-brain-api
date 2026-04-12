import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { lessons } from "./routes/lessons.js";
import { install } from "./routes/install.js";
import { rateLimit } from "./middleware/rate-limit.js";

const app = new Hono();

// Middleware
app.use("*", logger());
app.use(
  "*",
  cors({
    origin: ["*"], // Nimmit instances from anywhere
    allowMethods: ["POST", "GET"],
    allowHeaders: ["Content-Type", "Authorization", "X-Brain-Version"],
  })
);
app.use("/api/v1/*", rateLimit);

// Reject oversized bodies before they burn CPU
app.use("/api/v1/*", async (c, next) => {
  const contentLength = c.req.header("content-length");
  if (contentLength && parseInt(contentLength, 10) > 64_000) {
    return c.json({ error: "Payload too large" }, 413);
  }
  await next();
});

// Routes
app.route("/api/v1/brain", lessons);
app.route("/brain", install);

// Health check
app.get("/", (c) =>
  c.json({
    service: "nimmit-brain-api",
    version: "1.0.0",
    status: "ok",
    endpoints: {
      submitLesson: "POST /api/v1/brain/lessons",
      getLessons: "GET /api/v1/brain/lessons",
      health: "GET /api/v1/brain/health",
    },
  })
);

// 404
app.notFound((c) =>
  c.json({ error: "Not found", docs: "https://github.com/koompi/nimmit-brain-api" }, 404)
);

export default app;
