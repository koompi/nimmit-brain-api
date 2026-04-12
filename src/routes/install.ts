import { Hono } from "hono";

type Bindings = {
  GITHUB_TOKEN: string;
  LESSON_WEBHOOK_SECRET: string;
  ENVIRONMENT: string;
};

const app = new Hono<{ Bindings: Bindings }>();

const INSTALL_URL = "https://raw.githubusercontent.com/koompi/nimmit-brain/master/install.sh";

let cachedHash = "";
let hashFetchedAt = 0;

async function fetchInstallScript(): Promise<string> {
  const res = await fetch(INSTALL_URL, { headers: { "User-Agent": "nimmit-brain-api" } });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  return await res.text();
}

async function sha256Hex(data: string): Promise<string> {
  const encoded = new TextEncoder().encode(data);
  const hash = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function getScriptHash(): Promise<string> {
  const now = Date.now();
  if (cachedHash && now - hashFetchedAt < 300_000) return cachedHash;
  const script = await fetchInstallScript();
  cachedHash = await sha256Hex(script);
  hashFetchedAt = now;
  return cachedHash;
}

app.get("/install", async (c) => {
  let script: string;
  try {
    script = await fetchInstallScript();
  } catch {
    return c.text("#!/bin/bash\necho \"Error: Could not fetch install script. Visit https://github.com/koompi/nimmit-brain\"", 502, {
      "Content-Type": "text/x-shellscript",
    });
  }
  const hash = await sha256Hex(script);
  return c.text(script, 200, {
    "Content-Type": "text/x-shellscript",
    "Content-Disposition": 'attachment; filename="install.sh"',
    "X-Install-SHA256": hash,
  });
});

app.get("/install/sha256", async (c) => {
  try {
    const hash = await getScriptHash();
    return c.json({ sha256: hash, url: INSTALL_URL, timestamp: new Date().toISOString() });
  } catch {
    return c.json({ error: "Could not compute hash" }, 502);
  }
});

export { app as install };
export default app;
