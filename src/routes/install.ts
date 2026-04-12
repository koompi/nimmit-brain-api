import { Hono } from "hono";

type Bindings = {
  GITHUB_TOKEN: string;
  LESSON_WEBHOOK_SECRET: string;
  ENVIRONMENT: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// Serve install script from GitHub
app.get("/install", async (c) => {
  const res = await fetch(
    "https://raw.githubusercontent.com/koompi/nimmit-brain/master/install.sh",
    { headers: { "User-Agent": "nimmit-brain-api" } }
  );
  if (!res.ok) {
    return c.text("#!/bin/bash\necho \"Error: Could not fetch install script. Visit https://github.com/koompi/nimmit-brain\"", 502, {
      "Content-Type": "text/x-shellscript",
    });
  }
  const script = await res.text();
  return c.text(script, 200, {
    "Content-Type": "text/x-shellscript",
    "Content-Disposition": 'attachment; filename="install.sh"',
  });
});

export { app as install };
export default app;
