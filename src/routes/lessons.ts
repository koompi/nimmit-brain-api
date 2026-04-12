import { Hono } from "hono";

type Bindings = {
  GITHUB_TOKEN: string;
  LESSON_WEBHOOK_SECRET: string;
  ENVIRONMENT: string;
};

const app = new Hono<{ Bindings: Bindings }>();

interface Lesson {
  category: "procedural" | "semantic" | "workflow" | "anti-pattern";
  name: string;
  trigger: string;
  lesson: string;
  source: string; // generic description — no personal data
  brainVersion?: string;
  instanceId?: string; // anonymous identifier
}

interface LessonSubmission {
  lessons: Lesson[];
  brainVersion?: string;
  instanceId?: string;
}

// Health check
app.get("/health", (c) => c.json({ status: "ok", timestamp: new Date().toISOString() }));

// Submit lessons
app.post("/lessons", async (c) => {
  const body = await c.req.json<LessonSubmission>();

  // Validate
  if (!body.lessons || !Array.isArray(body.lessons) || body.lessons.length === 0) {
    return c.json({ error: "lessons array required, non-empty" }, 400);
  }

  if (body.lessons.length > 50) {
    return c.json({ error: "max 50 lessons per submission" }, 400);
  }

  const validCategories = ["procedural", "semantic", "workflow", "anti-pattern"];
  const errors: string[] = [];

  for (const lesson of body.lessons) {
    if (!lesson.category || !validCategories.includes(lesson.category)) {
      errors.push(`Invalid category: ${lesson.category}`);
    }
    if (!lesson.name || lesson.name.length > 200) {
      errors.push("name required, max 200 chars");
    }
    if (!lesson.lesson || lesson.lesson.length > 5000) {
      errors.push("lesson required, max 5000 chars");
    }
    if (!lesson.trigger || lesson.trigger.length > 1000) {
      errors.push("trigger required, max 1000 chars");
    }
    if (!lesson.source || lesson.source.length > 500) {
      errors.push("source required, max 500 chars");
    }
    // Privacy check: reject anything that looks like personal data
    if (containsPersonalData(lesson)) {
      errors.push(`Lesson "${lesson.name}" appears to contain personal data. Generalize before submitting.`);
    }
  }

  if (errors.length > 0) {
    return c.json({ error: "Validation failed", details: errors }, 400);
  }

  // In production: create a GitHub commit/PR to koompi/nimmit-brain
  // For Cloudflare Workers: use GitHub API
  const env = c.env;
  if (env?.GITHUB_TOKEN && env?.ENVIRONMENT === "production") {
    try {
      const result = await createGitHubContribution(body, env.GITHUB_TOKEN);
      return c.json({
        status: "accepted",
        lessonsReceived: body.lessons.length,
        contribution: result,
      }, 201);
    } catch (err) {
      console.error("GitHub contribution failed:", err);
      return c.json({ error: "Accepted but GitHub sync failed — will retry" }, 202);
    }
  }

  // Dev mode: just acknowledge
  return c.json({
    status: "accepted",
    lessonsReceived: body.lessons.length,
    note: "Dev mode — no GitHub sync",
  }, 201);
});

// Get recent lessons (public, for pulling)
app.get("/lessons", async (c) => {
  const since = c.req.query("since"); // ISO date string

  const env = c.env;
  if (env?.GITHUB_TOKEN) {
    try {
      const lessons = await fetchRecentLessons(env.GITHUB_TOKEN, since);
      return c.json({ lessons, count: lessons.length });
    } catch (err) {
      console.error("Failed to fetch lessons:", err);
    }
  }

  return c.json({ lessons: [], count: 0, note: "Dev mode" });
});

// --- Helpers ---

function containsPersonalData(lesson: Lesson): boolean {
  const text = `${lesson.name} ${lesson.lesson} ${lesson.source} ${lesson.trigger}`;
  // Email patterns
  if (/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(text)) return true;
  // Phone numbers (Cambodian style + other formats)
  if (/(?:\+?855|0)[0-9]{8,9}/.test(text)) return true;
  // URLs with paths that look like internal services
  if (/https?:\/\/[^\s]+\.local|192\.168\.|10\.\d+\.\d+\.\d+/.test(text)) return true;
  // Telegram/user IDs
  if (/\b\d{9,10}\b/.test(text) && /telegram|user|chat|id/i.test(text)) return true;
  // API keys / tokens
  if (/api[_-]?key|token|secret|password/i.test(text) && /[a-zA-Z0-9_-]{20,}/.test(text)) return true;
  // Names followed by specific titles (common in Cambodian context)
  if (/(?:Mr\.|Mrs\.|Ms\.|Dr\.|H\.E\.)\s+[A-Z][a-z]+\s+(?:said|told|asked|wants|needs)/i.test(text)) return true;
  return false;
}

async function createGitHubContribution(
  submission: LessonSubmission,
  token: string
): Promise<{ commitSha: string; filesChanged: number }> {
  const owner = "koompi";
  const repo = "nimmit-brain";
  const branch = `lesson/${Date.now()}`;

  // 1. Get main branch SHA
  const mainRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/refs/heads/master`, {
    headers: { Authorization: `Bearer ${token}`, "User-Agent": "nimmit-brain-api" },
  });
  const mainData = await mainRes.json();
  const mainSha = mainData.object.sha;

  // 2. Create branch
  await fetch(`https://api.github.com/repos/${owner}/${repo}/git/refs`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "User-Agent": "nimmit-brain-api" },
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: mainSha }),
  });

  // 3. Build file blobs
  const filesChanged: string[] = [];
  const blobs: { path: string; content: string; sha?: string }[] = [];

  for (const lesson of submission.lessons) {
    const dir = lesson.category === "anti-pattern" ? "failures" : lesson.category;
    const filename = slugify(lesson.name);
    const path = `brain/memory/${dir}/${filename}.md`;
    const content = formatLesson(lesson);

    // Check if file exists
    const existingRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
      { headers: { Authorization: `Bearer ${token}`, "User-Agent": "nimmit-brain-api" } }
    );

    if (existingRes.ok) {
      const existing = await existingRes.json();
      blobs.push({ path, content, sha: existing.sha });
    } else {
      blobs.push({ path, content });
    }
    filesChanged.push(path);
  }

  // 4. Create blobs and tree
  const treeItems = [];
  for (const file of blobs) {
    const blobRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/blobs`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "User-Agent": "nimmit-brain-api" },
      body: JSON.stringify({ content: file.content, encoding: "utf-8" }),
    });
    const blob = await blobRes.json();
    treeItems.push({
      path: file.path,
      mode: "100644",
      type: "blob",
      sha: blob.sha,
    });
  }

  // 5. Create tree
  const treeRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "User-Agent": "nimmit-brain-api" },
    body: JSON.stringify({ base_tree: mainSha, tree: treeItems }),
  });
  const tree = await treeRes.json();

  // 6. Create commit
  const commitRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/commits`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "User-Agent": "nimmit-brain-api" },
    body: JSON.stringify({
      message: `evolution: ${submission.lessons.length} lesson(s) from community\n\nCategories: ${[...new Set(submission.lessons.map(l => l.category))].join(", ")}\nBrain version: ${submission.brainVersion || "unknown"}`,
      tree: tree.sha,
      parents: [mainSha],
    }),
  });
  const commit = await commitRes.json();

  // 7. Update branch
  await fetch(`https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "User-Agent": "nimmit-brain-api" },
    body: JSON.stringify({ sha: commit.sha }),
  });

  // 8. Create PR
  await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "User-Agent": "nimmit-brain-api" },
    body: JSON.stringify({
      title: `🧠 Evolution: ${submission.lessons.length} community lesson(s)`,
      body: formatPRBody(submission),
      head: branch,
      base: "master",
    }),
  });

  return { commitSha: commit.sha, filesChanged: filesChanged.length };
}

async function fetchRecentLessons(
  token: string,
  since?: string
): Promise<Array<{ path: string; content: string; date: string }>> {
  const owner = "koompi";
  const repo = "nimmit-brain";

  const sinceParam = since ? `&since=${encodeURIComponent(since)}` : "";
  const commitsRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/commits?path=brain/memory&per_page=10${sinceParam}`,
    { headers: { Authorization: `Bearer ${token}`, "User-Agent": "nimmit-brain-api" } }
  );
  const commits = await commitsRes.json();

  const lessons: Array<{ path: string; content: string; date: string }> = [];

  for (const commit of commits.slice(0, 5)) {
    for (const file of commit.files || []) {
      if (file.filename.startsWith("brain/memory/") && file.filename.endsWith(".md")) {
        // Fetch file content
        const contentRes = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/contents/${file.filename}`,
          { headers: { Authorization: `Bearer ${token}`, "User-Agent": "nimmit-brain-api" } }
        );
        if (contentRes.ok) {
          const data = await contentRes.json();
          const content = Buffer.from(data.content, "base64").toString("utf-8");
          lessons.push({ path: file.filename, content, date: commit.commit.author.date });
        }
      }
    }
  }

  return lessons;
}

function formatLesson(lesson: Lesson): string {
  return `# ${lesson.name}

## Category
${lesson.category}

## Trigger
${lesson.trigger}

## Lesson
${lesson.lesson}

## Source
${lesson.source}

_Auto-submitted via nimmit-brain-api_
`;
}

function formatPRBody(submission: LessonSubmission): string {
  const lines = submission.lessons.map((l) => `- **${l.name}** (${l.category}): ${l.lesson.slice(0, 100)}...`);
  return `## Community Evolution Submission\n\n${lines.join("\n")}\n\n---\n\nBrain version: ${submission.brainVersion || "unknown"}\nLessons: ${submission.lessons.length}\nCategories: ${[...new Set(submission.lessons.map((l) => l.category))].join(", ")}\n\n🤖 Auto-generated by nimmit-brain-api`;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);
}

export { app as lessons };
export default app;
