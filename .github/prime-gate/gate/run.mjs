// Collects facts for one PR from the GitHub API and the hub repo, evaluates them, prints the verdict, exits 1 on fail.
// Usage: GITHUB_TOKEN=... node run.mjs <owner/repo> <pr-number>
// Hotfix mode also needs PRIME_RELAY_URL, PRIME_RELAY_TOKEN, PRIME_RELAY_KEY (PEM); without them it fails closed.
import { evaluateAc, evaluateHotfix, parseListMap, parseSliceRef } from "./core.mjs";
import { checkIncident } from "../relay/relay.mjs";

const HUB = process.env.PRIME_HUB ?? "GA-MO-DEV/prime-hub-test";
const HUB_LOG = "prime-log";

async function gh(path, { raw = false, allow404 = false } = {}) {
  const res = await fetch(`https://api.github.com/${path}`, {
    headers: {
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    },
  });
  if (allow404 && res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub ${res.status} ${path}`);
  return raw ? res.text() : res.json();
}

async function all(path) {
  const out = [];
  for (let page = 1; ; page++) {
    const batch = await gh(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    out.push(...batch);
    if (batch.length < 100) return out;
  }
}

const file = (repo, path, ref) => gh(`repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`, { raw: true, allow404: true });

async function dirFiles(repo, dir, ref) {
  const list = await gh(`repos/${repo}/contents/${dir}?ref=${encodeURIComponent(ref)}`, { allow404: true });
  if (!Array.isArray(list)) return [];
  return Promise.all(list.filter((e) => e.type === "file" && e.name.endsWith(".md")).map(async (e) => ({ name: e.name, text: await file(repo, e.path, ref) })));
}

const listField = (text, key) => {
  const m = new RegExp(`^${key}:\\s*\\[(.*)\\]\\s*$`, "m").exec(text);
  return m ? m[1].split(",").map((s) => s.trim()).filter(Boolean) : [];
};
const scalarField = (text, key) => new RegExp(`^${key}:\\s*(\\S+)\\s*$`, "m").exec(text)?.[1] ?? null;

async function acFacts(pr) {
  const slice = parseSliceRef(pr.head.ref);
  if (!slice) return { slice: null };
  const base = `docs/features/${slice.feature}`;
  const [specMd, planMd, approvals, halts] = await Promise.all([
    file(HUB, `${base}/spec.md`, "main"),
    file(HUB, `${base}/plan.md`, "main"),
    dirFiles(HUB, `docs/approvals/${slice.feature}`, HUB_LOG),
    dirFiles(HUB, `docs/halts/${slice.feature}`, HUB_LOG),
  ]);
  return {
    slice,
    specMd: specMd ?? "",
    planMd: planMd ?? "",
    approvals: approvals.map((a) => ({ id: a.name.replace(/\.md$/, ""), status: scalarField(a.text, "status"), affects: listField(a.text, "affects") })),
    holds: halts.filter((h) => scalarField(h.text, "status") !== "released").flatMap((h) => listField(h.text, "affects")),
  };
}

async function hotfixFacts(repo, pr) {
  const incidentId = pr.base.ref.slice("hotfix/".length);
  const relay = process.env.PRIME_RELAY_URL;
  const incident = relay
    ? await checkIncident({ relayUrl: relay, serverToken: process.env.PRIME_RELAY_TOKEN, publicKeyPem: process.env.PRIME_RELAY_KEY, incidentId })
    : { ok: false, why: "ไม่มี relay ให้ถาม (gate ใน Actions ไม่ถือ token ของ relay) จึง fail ปิด" };

  const main = await gh(`repos/${repo}/branches/main`);
  const tags = await all(`repos/${repo}/tags`);
  const mainTag = tags.find((t) => /^r-/.test(t.name) && t.commit.sha === main.commit.sha)?.name ?? null;
  const cmp = await gh(`repos/${repo}/compare/${main.commit.sha}...${pr.base.sha}`);
  const mainIsAncestor = cmp.status === "ahead" || cmp.status === "identical";
  const foreign = [];
  if (mainIsAncestor) {
    for (const c of cmp.commits) {
      const prs = await gh(`repos/${repo}/commits/${c.sha}/pulls`);
      if (!prs.some((p) => p.merged_at && p.base.ref === pr.base.ref)) foreign.push(c.sha);
    }
  }

  const [files, reviews, codeowners, teamMd] = await Promise.all([
    all(`repos/${repo}/pulls/${pr.number}/files`),
    all(`repos/${repo}/pulls/${pr.number}/reviews`),
    file(repo, ".github/CODEOWNERS", pr.base.sha),
    file(HUB, "team.md", "main"),
  ]);
  return {
    author: pr.user.login,
    headSha: pr.head.sha,
    incidentId,
    org: repo.split("/")[0],
    incident,
    base: { mainTag, mainIsAncestor, foreign },
    files,
    codeowners: codeowners ?? "",
    reviews: reviews.map((r) => ({ login: r.user.login, state: r.state, commit_id: r.commit_id })),
    teams: parseListMap(teamMd ?? ""),
  };
}

const [repo, number] = process.argv.slice(2);
if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? "") || !/^\d+$/.test(number ?? "")) {
  console.error("usage: node run.mjs <owner/repo> <pr-number>");
  process.exit(2);
}
const pr = await gh(`repos/${repo}/pulls/${number}`);
const verdict = pr.base.ref.startsWith("hotfix/") ? evaluateHotfix(await hotfixFacts(repo, pr)) : evaluateAc(await acFacts(pr));
console.log(`${verdict.ok ? "PASS" : "FAIL"} ${verdict.title}`);
for (const l of verdict.lines) console.log(l);
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import("node:fs");
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ${verdict.ok ? "ผ่าน" : "ไม่ผ่าน"}: ${verdict.title}\n\n${verdict.lines.map((l) => `- ${l}`).join("\n")}\n`);
}
process.exit(verdict.ok ? 0 : 1);
