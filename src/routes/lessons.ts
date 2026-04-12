import { Hono } from "hono";


type Bindings = {
  GITHUB_TOKEN: string;
  LESSON_WEBHOOK_SECRET: string;
  ENVIRONMENT: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// In-memory cache (persists for Worker isolate lifetime, ~30s-5min)
const keyCache = new Map<string, { instanceId: string; brainVersion: string; lessonCount: number; createdAt: string }>();

interface Lesson {
  category: "procedural" | "semantic" | "workflow" | "anti-pattern";
  name: string;
  trigger: string;
  lesson: string;
  source: string;
}

interface LessonSubmission {
  lessons: Lesson[];
  brainVersion?: string;
  instanceId?: string;
}

const GITHUB_OWNER = "koompi";
const GITHUB_REPO = "nimmit-brain-api";
const KEYS_PATH = ".keys/instances.json";

const SHORT_URL_DOMAINS = ["bit.ly", "t.co", "tinyurl", "goo.gl", "ow.ly", "is.gd", "buff.ly", "rb.gy", "cutt.ly", "shorturl.at"];

// ---- Crypto helpers ----

async function sha256(str: string): Promise<string> {
  const encoded = new TextEncoder().encode("nimmit-key-salt:" + str); const hash = await crypto.subtle.digest("SHA-256", encoded); return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function hmacSha256(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)); return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ---- Key Store (GitHub-backed) ----

interface KeyEntry {
  instanceId: string;
  brainVersion: string;
  createdAt: string;
  lessonCount: number;
  weeklyLessonCount: number;
  weeklyResetAt: string;
  lastSubmit: string | null;
  banned: boolean;
  keyHash: string; // SHA256 of the API key — never store raw keys
}

async function getKeysData(token: string): Promise<{ keys: Record<string, KeyEntry>; sha: string }> {
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${KEYS_PATH}`,
    { headers: { Authorization: `Bearer ${token}`, "User-Agent": "nimmit-brain-api" }, cache: "no-store" }
  );
  if (!res.ok) return { keys: {}, sha: "" };
  const data = await res.json();
  const content = atob(data.content.replace(/\n/g, ""));
  return { keys: JSON.parse(content), sha: data.sha };
}

async function saveKeysData(token: string, keys: Record<string, KeyEntry>): Promise<void> {
  const { sha } = await getKeysData(token);
  const content = JSON.stringify(keys, null, 2);
  const body: any = {
    message: `chore: update key store (${Object.keys(keys).length} instances)`,
    content: btoa(unescape(encodeURIComponent(content))),
  };
  if (sha) body.sha = sha;
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${KEYS_PATH}`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "User-Agent": "nimmit-brain-api" },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to save keys: ${res.status} ${err}`);
  }
}

async function lookupKey(token: string, apiKey: string): Promise<{ instanceId: string; banned: boolean; createdAt: string; weeklyLessonCount: number; weeklyResetAt: string } | null> {
  const cached = keyCache.get(apiKey);
  if (cached) return { instanceId: cached.instanceId, banned: false, createdAt: cached.createdAt, weeklyLessonCount: 0, weeklyResetAt: "" };

  const { keys } = await getKeysData(token);
  const hash = await sha256(apiKey);
  let entry: KeyEntry | undefined;
  for (const e of Object.values(keys)) {
    if (e.keyHash === hash) { entry = e; break; }
  }
  if (!entry) return null;

  keyCache.set(apiKey, { instanceId: entry.instanceId, brainVersion: entry.brainVersion, lessonCount: entry.lessonCount, createdAt: entry.createdAt });

  return { instanceId: entry.instanceId, banned: entry.banned || false, createdAt: entry.createdAt, weeklyLessonCount: entry.weeklyLessonCount || 0, weeklyResetAt: entry.weeklyResetAt || "" };
}

function getInstanceStatus(createdAt: string): "probation" | "active" {
  const age = Date.now() - new Date(createdAt).getTime();
  return age < 7 * 24 * 60 * 60 * 1000 ? "probation" : "active";
}

function checkWeeklyLimit(entry: { weeklyLessonCount: number; weeklyResetAt: string }, requested: number): { allowed: boolean; resetAt: string } {
  const now = Date.now();
  let resetAt = entry.weeklyResetAt ? new Date(entry.weeklyResetAt).getTime() : 0;
  let count = entry.weeklyLessonCount || 0;

  if (now >= resetAt) {
    count = 0;
    resetAt = now + 7 * 24 * 60 * 60 * 1000;
  }

  if (count + requested > 20) return { allowed: false, resetAt: new Date(resetAt).toISOString() };
  return { allowed: true, resetAt: new Date(resetAt).toISOString() };
}

// ---- Slug collision check ----

async function slugExists(token: string, slug: string): Promise<boolean> {
  const dirs = ["brain/memory/incoming", "brain/memory/procedural", "brain/memory/semantic", "brain/memory/workflow", "brain/memory/failures"];
  for (const dir of dirs) {
    const res = await fetch(
      `https://api.github.com/repos/koompi/nimmit-brain/contents/${dir}`,
      { headers: { Authorization: `Bearer ${token}`, "User-Agent": "nimmit-brain-api" } }
    );
    if (res.ok) {
      const files = await res.json();
      if (Array.isArray(files) && files.some((f: any) => f.name === `${slug}.md`)) return true;
    }
  }
  return false;
}

// ---- Endpoints ----

app.get("/health", (c) => c.json({ status: "ok", timestamp: new Date().toISOString() }));

app.post("/register", async (c) => {
  const body = await c.req.json<{ instanceId?: string; brainVersion?: string }>().catch(() => null);
  if (!body?.instanceId || body.instanceId.length > 100 || !/^[a-zA-Z0-9._-]+$/.test(body.instanceId)) {
    return c.json({ error: "instanceId: alphanumeric, dots, dashes, underscores, max 100 chars" }, 400);
  }

  const env = c.env;
  if (!env.GITHUB_TOKEN || env.ENVIRONMENT !== "production") {
    return c.json({ error: "Registration requires production environment" }, 503);
  }

  const { keys, sha } = await getKeysData(env.GITHUB_TOKEN);

  // Check if already registered — generate NEW key regardless (anti-enumeration)
  let existingEntry: KeyEntry | undefined;
  for (const e of Object.values(keys)) {
    if (e.instanceId === body.instanceId) { existingEntry = e; break; }
  }

  const apiKey = `nk_${crypto.randomUUID().replace(/-/g, "")}`;
  const hash = await sha256(apiKey);
  const now = new Date().toISOString();

  keys[hash] = {
    instanceId: body.instanceId,
    brainVersion: body.brainVersion || "unknown",
    createdAt: existingEntry?.createdAt || now,
    lessonCount: existingEntry?.lessonCount || 0,
    weeklyLessonCount: 0,
    weeklyResetAt: now,
    lastSubmit: existingEntry?.lastSubmit || null,
    banned: existingEntry?.banned || false,
    keyHash: hash,
  };

  // Remove old entry if it existed (different hash)
  if (existingEntry) {
    const oldHash = existingEntry.keyHash;
    if (oldHash && oldHash !== hash) delete keys[oldHash];
  }

  await saveKeysData(env.GITHUB_TOKEN, keys);

  keyCache.set(apiKey, { instanceId: body.instanceId, brainVersion: body.brainVersion || "unknown", lessonCount: keys[hash].lessonCount, createdAt: keys[hash].createdAt });

  // Always same response format — never reveal if instance existed
  return c.json({
    status: "registered",
    instanceId: body.instanceId,
    apiKey,
    expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    usage: "Authorization: Bearer <apiKey>",
  }, 201);
});

// ---- Lesson Submission ----

app.post("/lessons", async (c) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer nk_")) {
    return c.json({ error: "Missing API key. Register at POST /api/v1/brain/register" }, 401);
  }
  const apiKey = authHeader.replace("Bearer ", "");
  const env = c.env;

  const keyEntry = await lookupKey(env.GITHUB_TOKEN, apiKey);
  if (!keyEntry) return c.json({ error: "Invalid API key" }, 401);
  if (keyEntry.banned) return c.json({ error: "Instance banned. Contact support." }, 403);

  const body = await c.req.json<LessonSubmission>();
  if (!body.lessons || !Array.isArray(body.lessons) || body.lessons.length === 0) {
    return c.json({ error: "lessons array required" }, 400);
  }

  // Probation / rate limits
  const status = getInstanceStatus(keyEntry.createdAt);
  const maxPerSubmit = status === "probation" ? 3 : 20;
  const weeklyMax = status === "probation" ? 5 : 20;

  if (body.lessons.length > maxPerSubmit) {
    return c.json({ error: `Max ${maxPerSubmit} lessons per submission` }, 400);
  }

  const weekCheck = checkWeeklyLimit(keyEntry, body.lessons.length);
  if (!weekCheck.allowed) {
    return c.json({ error: "Weekly lesson limit reached", retryAfter: weekCheck.resetAt }, 429);
  }

  const validCategories = ["procedural", "semantic", "workflow", "anti-pattern"];
  const errors: string[] = [];

  for (const lesson of body.lessons) {
    if (!lesson.category || !validCategories.includes(lesson.category)) errors.push(`[${lesson.category}] Invalid category`);
    if (!lesson.name || lesson.name.length > 100) errors.push("name: max 100 chars");
    if (!lesson.lesson || lesson.lesson.length > 2000) errors.push("lesson: max 2000 chars");
    if (!lesson.trigger || lesson.trigger.length > 500) errors.push("trigger: max 500 chars");
    if (!lesson.source || lesson.source.length > 300) errors.push("source: max 300 chars");

    if (containsPersonalData(lesson)) errors.push(`"${lesson.name}": personal data detected`);
    if (containsMaliciousContent(lesson)) errors.push(`"${lesson.name}": potentially malicious`);
    if (containsInstructionInjection(lesson)) errors.push(`"${lesson.name}": contains system instructions (lessons must be behavioral advice only, not commands)`);
  }

  if (errors.length > 0) return c.json({ error: "Validation failed", details: errors }, 400);

  // Slug collision check
  if (env.GITHUB_TOKEN && env.ENVIRONMENT === "production") {
    for (const lesson of body.lessons) {
      const slug = slugify(lesson.name);
      if (await slugExists(env.GITHUB_TOKEN, slug)) {
        return c.json({ error: "A lesson with similar name already exists", slug }, 409);
      }
    }
  }

  // GATE 2: Quarantine
  if (env.GITHUB_TOKEN && env.ENVIRONMENT === "production") {
    try {
      const result = await createQuarantinedPR(body, env.GITHUB_TOKEN, keyEntry.instanceId);
      // Update lesson counts
      const { keys } = await getKeysData(env.GITHUB_TOKEN);
      const hash = await sha256(apiKey);
      if (keys[hash]) {
        keys[hash].lessonCount += body.lessons.length;
        keys[hash].lastSubmit = new Date().toISOString();
        // Update weekly counter
        const now = Date.now();
        const resetAt = keys[hash].weeklyResetAt ? new Date(keys[hash].weeklyResetAt).getTime() : 0;
        if (now >= resetAt) {
          keys[hash].weeklyLessonCount = body.lessons.length;
          keys[hash].weeklyResetAt = new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString();
        } else {
          keys[hash].weeklyLessonCount = (keys[hash].weeklyLessonCount || 0) + body.lessons.length;
        }
        await saveKeysData(env.GITHUB_TOKEN, keys);
      }

      return c.json({
        status: "quarantined",
        lessonsReceived: body.lessons.length,
        instanceId: keyEntry.instanceId,
        pr: result.prUrl,
        note: "Lessons quarantined for review. They will NOT activate until approved.",
      }, 201, { "X-Instance-Status": status });
    } catch (err) {
      return c.json({ error: "GitHub sync failed", details: String(err) }, 500);
    }
  }

  return c.json({ status: "accepted", lessonsReceived: body.lessons.length, note: "Dev mode" }, 201);
});

// ---- GET /lessons with content verification ----

app.get("/lessons", async (c) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer nk_")) return c.json({ error: "API key required" }, 401);

  const env = c.env;
  const since = c.req.query("since");
  let lessons: any[] = [];
  if (env?.GITHUB_TOKEN) {
    try {
      lessons = await fetchApprovedLessons(env.GITHUB_TOKEN, since);
    } catch { /* fall through */ }
  }

  const respBody = JSON.stringify({ lessons, count: lessons.length });
  const resp = new Response(respBody, {
    headers: { "Content-Type": "application/json" },
  });
  resp.headers.append("X-Lessons-Count", String(lessons.length));
  const lastReview = lessons.length > 0 ? lessons[0].date : "";
  if (lastReview) resp.headers.append("X-Last-Review", lastReview);
  if (env.LESSON_WEBHOOK_SECRET) {
    resp.headers.append("X-Content-Signature", await hmacSha256(env.LESSON_WEBHOOK_SECRET, respBody));
  }
  return resp;
});

// ---- Fetch approved lessons ----

async function fetchApprovedLessons(token: string, since?: string) {
  const sinceParam = since ? `&since=${encodeURIComponent(since)}` : "";
  const res = await fetch(
    `https://api.github.com/repos/koompi/nimmit-brain/commits?path=brain/memory/procedural,brain/memory/semantic,brain/memory/failures,brain/memory/workflow&per_page=10${sinceParam}`,
    { headers: { Authorization: `Bearer ${token}`, "User-Agent": "nimmit-brain-api" } }
  );
  const commits = await res.json();
  const lessons: any[] = [];
  for (const commit of commits.slice(0, 5)) {
    for (const file of commit.files || []) {
      if (file.filename.includes("/incoming/")) continue;
      if (!file.filename.startsWith("brain/memory/")) continue;
      if (!file.filename.endsWith(".md")) continue;
      const cRes = await fetch(
        `https://api.github.com/repos/koompi/nimmit-brain/contents/${file.filename}`,
        { headers: { Authorization: `Bearer ${token}`, "User-Agent": "nimmit-brain-api" } }
      );
      if (cRes.ok) {
        const data = await cRes.json();
        lessons.push({ path: file.filename, content: atob(data.content.replace(/\n/g, "")), date: commit.commit.author.date });
      }
    }
  }
  return lessons;
}

// ---- Quarantine PR ----

async function createQuarantinedPR(submission: LessonSubmission, token: string, instanceId: string) {
  const owner = "koompi", repo = "nimmit-brain";
  const branch = `incoming/${Date.now()}`;

  const mainRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/refs/heads/master`, {
    headers: { Authorization: `Bearer ${token}`, "User-Agent": "nimmit-brain-api" },
  });
  if (!mainRes.ok) throw new Error(`Master ref: ${mainRes.status}`);
  const mainSha = (await mainRes.json()).object?.sha;

  await fetch(`https://api.github.com/repos/${owner}/${repo}/git/refs`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "User-Agent": "nimmit-brain-api" },
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: mainSha }),
  });

  const treeItems: any[] = [];
  for (const lesson of submission.lessons) {
    const content = `# ${lesson.name}\n\n## Category\n${lesson.category}\n\n## Trigger\n${lesson.trigger}\n\n## Lesson\n${lesson.lesson}\n\n## Source\n${lesson.source}\n\n---\n_Quarantined — awaiting review_\n_Instance: ${instanceId}_\n_Submitted: ${new Date().toISOString()}_\n`;
    const blobRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/blobs`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "User-Agent": "nimmit-brain-api" },
      body: JSON.stringify({ content, encoding: "utf-8" }),
    });
    const blob = await blobRes.json();
    treeItems.push({ path: `brain/memory/incoming/${slugify(lesson.name)}.md`, mode: "100644", type: "blob", sha: blob.sha });
  }

  const treeRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "User-Agent": "nimmit-brain-api" },
    body: JSON.stringify({ base_tree: mainSha, tree: treeItems }),
  });
  const tree = await treeRes.json();

  const commitRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/commits`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "User-Agent": "nimmit-brain-api" },
    body: JSON.stringify({
      message: `quarantine: ${submission.lessons.length} lesson(s) from ${instanceId}`,
      tree: tree.sha, parents: [mainSha],
    }),
  });
  const commit = await commitRes.json();

  await fetch(`https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "User-Agent": "nimmit-brain-api" },
    body: JSON.stringify({ sha: commit.sha }),
  });

  const prRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "User-Agent": "nimmit-brain-api" },
    body: JSON.stringify({
      title: `🔒 Quarantine: ${submission.lessons.length} lesson(s) from ${instanceId}`,
      body: `## ⚠️ Quarantined Lessons\n\nThese lessons are in \`brain/memory/incoming/\` and **will NOT activate** until reviewed and approved.\n\n### Review Checklist\n- [ ] No instruction injection (URLs, commands, startup hooks)\n- [ ] No personal data\n- [ ] Lesson is behavioral advice, not a system command\n- [ ] Source is generic, no identifiable info\n- [ ] Category is correct\n\n### To Approve\n1. Review each file in \`brain/memory/incoming/\`\n2. Move approved files to appropriate \`brain/memory/<category>/\`\n3. Delete from \`incoming/\`\n4. Merge PR\n\n### To Reject\n1. Close PR with explanation\n2. Optionally ban instance: edit \`.keys/instances.json\` in nimmit-brain-api repo\n\n---\nInstance: ${instanceId}\nBrain: ${submission.brainVersion || "unknown"}\nCategories: ${[...new Set(submission.lessons.map(l => l.category))].join(", ")}\n\n🤖 nimmit.koompi.ai`,
      head: branch, base: "master",
    }),
  });
  const pr = await prRes.json();

  return { commitSha: commit.sha, prUrl: pr.html_url, prNumber: pr.number };
}

// ---- Security Checks ----

function containsPersonalData(lesson: Lesson): boolean {
  const text = `${lesson.name} ${lesson.lesson} ${lesson.source} ${lesson.trigger}`;
  if (/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(text)) return true;
  if (/(?:\+?855|0)[0-9]{8,9}/.test(text)) return true;
  if (/https?:\/\/[^\s]+\.local|192\.168\.|10\.\d+\.\d+\.\d+/.test(text)) return true;
  if (/\b\d{9,10}\b/.test(text) && /telegram|user|chat|id/i.test(text)) return true;
  if (/api[_-]?key|token|secret|password/i.test(text) && /[a-zA-Z0-9_-]{20,}/.test(text)) return true;
  if (/(?:Mr\.|Mrs\.|Ms\.|Dr\.|H\.E\.)\s+[A-Z][a-z]+\s+(?:said|told|asked|wants|needs)/i.test(text)) return true;
  return false;
}

function containsMaliciousContent(lesson: Lesson): boolean {
  const text = `${lesson.name} ${lesson.lesson} ${lesson.source}`.toLowerCase();
  if (/modify.*soul|change.*identity|update.*approval|remove.*red.?line|bypass.*security/i.test(text)) return true;
  if (/exfil|send.*data.*to|upload.*secrets|dump.*database|export.*credentials/i.test(text)) return true;
  if (/reverse.?shell|backdoor|persistence|escalat|privilege|sudo|root.*access/i.test(text)) return true;
  if (/ignore.*validation|skip.*privacy|disable.*filter|always.*accept/i.test(text)) return true;
  if (/change.*model|switch.*provider|redirect.*api|overwrite.*config|modify.*gateway/i.test(text)) return true;
  if (/<script|javascript:|onerror|onload|onclick/i.test(text)) return true;
  return false;
}

function containsInstructionInjection(lesson: Lesson): boolean {
  const text = `${lesson.name} ${lesson.lesson} ${lesson.trigger} ${lesson.source}`;

  // URLs with protocol
  if (/https?:\/\/[^\s]+/.test(text)) return true;

  // Short URL domains
  for (const domain of SHORT_URL_DOMAINS) {
    if (new RegExp(`\\b${domain.replace(".", "\\.")}\\b`, "i").test(text)) return true;
  }

  // URL-like patterns without protocol (domain.tld/path)
  if (/[a-zA-Z0-9][a-zA-Z0-9-]*\.[a-zA-Z]{2,}(\/[^\s]*)?/.test(text)) return true;

  // File paths that look like system paths
  if (/\/(?:etc|usr|var|tmp|home|root|\.ssh|\.config|\.secrets)\//i.test(text)) return true;
  if (/~\/\.(?:bashrc|zshrc|profile|ssh|config|secrets)/i.test(text)) return true;

  // .git references
  if (/\.git(?:hub)?\b|dot\s*git/i.test(text)) return true;

  // Commands and code execution
  if (/\b(fetch|curl|wget|exec|eval|import|require|source|load|run|execute|spawn|invoke)\b.*\b(from|at|https?|\/|file)\b/i.test(text)) return true;
  if (/`[^`]+`/.test(lesson.lesson) && !/don't|can't|won't|it's|that's/i.test(lesson.lesson)) return true;
  if (/\$\{[^}]+\}|\$\w+/.test(text)) return true;

  // System hooks
  if (/\b(on\s+startup|on\s+boot|on\s+first\s+run|on\s+heartbeat|every\s+startup|at\s+boot|on\s+launch|before\s+init|on\s+install|after\s+install)\b/i.test(text)) return true;

  // Config modification
  if (/\b(add\s+to\s+config|update\s+config|modify\s+config|change\s+setting|set\s+env|write\s+to\s+file|append\s+to)\b/i.test(text)) return true;

  // Network instructions
  if (/\b(send|forward|redirect|upload|post|push|connect\s+to|dial|ping)\b.*\b(url|server|endpoint|api|host|ip|address|domain)\b/i.test(text)) return true;

  // Template/literal injection
  if (/\b(you\s+must|you\s+should\s+always|always\s+fetch|never\s+reject|ignore\s+the\s+filter)\b/i.test(text)) return true;

  // Base64 encoded strings (20+ chars of base64)
  if (/[A-Za-z0-9+\/]{20,}={0,2}/.test(text)) return true;

  // Hex encoded strings (10+ hex chars)
  if (/(?:0x)?[0-9a-fA-F]{20,}/.test(text)) return true;

  // Unicode homoglyph attacks — fullwidth/lookalike chars for http, curl, etc.
  if (/[\uFF48\uFF54\uFF54\uFF50\u02CF\uFF43\uFF55\uFF52\uFF4C]/.test(text)) return true;

  // Whitespace/invisible character injection (zero-width spaces, etc.)
  if (/[\u200B-\u200F\u2028-\u202F\uFEFF]/.test(text)) return true;

  // DNS-like patterns without protocol
  if (/[a-zA-Z0-9-]+\.[a-zA-Z0-9-]+\.(?:com|net|org|io|dev|xyz|cc|co|me|app|ai|cloud|run|sh)[\/\s]?/i.test(text)) return true;

  return false;
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 60);
}

export { app as lessons };
export default app;
