// Collects facts for one PR from the GitHub API and the hub repo, evaluates them, prints the verdict, exits 1 on fail.
// Usage: GITHUB_TOKEN=... node run.mjs <owner/repo> <pr-number>
// Hotfix mode also needs PRIME_RELAY_URL, PRIME_RELAY_TOKEN, PRIME_RELAY_KEY (PEM); without them it fails closed.
import { currentApprovers, engineers, evaluateAc, evaluateBackMerge, evaluateGoLive, evaluateHotfix, evaluateLocked, parseListMap, parseSliceRef, route } from "./core.mjs";
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

const CODEOWNERS_PATHS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];

async function codeownersAt(repo, ref) {
  for (const path of CODEOWNERS_PATHS) {
    const text = await file(repo, path, ref);
    if (text !== null) return text;
  }
  return null;
}

const containsCommit = async (repo, ref, sha) => ["behind", "identical"].includes((await gh(`repos/${repo}/compare/${encodeURIComponent(ref)}...${sha}`)).status);

/**
 * Base facts for a branch about to land on main (hotfix PR, or go-live). Every commit between main HEAD and the branch
 * tip (and the incoming PR head) must have arrived properly: for hotfix through a PR into this branch and never from
 * develop, for a release from develop or a PR into the release branch.
 */
async function baseFacts(repo, branch, { headSha = null, prCommits = new Set() } = {}) {
  const main = await gh(`repos/${repo}/branches/main`);
  const tags = await all(`repos/${repo}/tags`);
  const mainTag = tags.find((t) => /^r-/.test(t.name) && t.commit.sha === main.commit.sha)?.name ?? null;
  const tip = (await gh(`repos/${repo}/branches/${encodeURIComponent(branch)}`)).commit.sha;
  const ends = headSha ? [tip, headSha] : [tip];
  const compares = await Promise.all(ends.map((sha) => gh(`repos/${repo}/compare/${main.commit.sha}...${sha}`)));
  const mainIsAncestor = compares.every((c) => c.status === "ahead" || c.status === "identical");
  const foreign = [];
  if (compares.some((c) => c.total_commits > c.commits.length)) foreign.push(`(compare API ให้แค่ ${Math.min(...compares.map((c) => c.commits.length))} จาก ${Math.max(...compares.map((c) => c.total_commits))} commit จึงตรวจไม่ครบ)`);
  if (mainIsAncestor && foreign.length === 0) {
    const commits = new Map(compares.flatMap((c) => c.commits.map((x) => [x.sha, x])));
    for (const sha of commits.keys()) {
      const onDevelop = await containsCommit(repo, "develop", sha);
      const viaBranchPr = (await gh(`repos/${repo}/commits/${sha}/pulls`)).some((p) => p.merged_at && p.base.ref === branch);
      const ok = branch.startsWith("release/") ? onDevelop || viaBranchPr : !onDevelop && (viaBranchPr || prCommits.has(sha));
      if (!ok) {
        foreign.push(sha);
        break;
      }
    }
  }
  return { tip, base: { mainTag, mainIsAncestor, foreign } };
}

async function reviewsAndTeams(repo, pr) {
  const [files, reviews, teamMd] = await Promise.all([all(`repos/${repo}/pulls/${pr.number}/files`), all(`repos/${repo}/pulls/${pr.number}/reviews`), file(HUB, "team.md", "main")]);
  return {
    files,
    reviews: reviews.map((r) => ({ login: r.user.login, state: r.state, commit_id: r.commit_id })),
    teams: parseListMap(teamMd ?? ""),
  };
}

async function hotfixFacts(repo, pr) {
  const incidentId = pr.base.ref.slice("hotfix/".length);
  const relay = process.env.PRIME_RELAY_URL;
  const incident = relay
    ? await checkIncident({ relayUrl: relay, serverToken: process.env.PRIME_RELAY_TOKEN, publicKeyPem: process.env.PRIME_RELAY_KEY, incidentId })
    : { ok: false, why: "ไม่มี relay ให้ถาม (gate ใน Actions ไม่ถือ token ของ relay) จึง fail ปิด" };
  const prCommits = new Set((await all(`repos/${repo}/pulls/${pr.number}/commits`)).map((c) => c.sha));
  const { tip, base } = await baseFacts(repo, pr.base.ref, { headSha: pr.head.sha, prCommits });
  const [rt, codeowners] = await Promise.all([reviewsAndTeams(repo, pr), codeownersAt(repo, tip)]);
  return { author: pr.user.login, headSha: pr.head.sha, incidentId, org: repo.split("/")[0], incident, base, codeowners, ...rt };
}

async function backMergeVerdict(repo, pr) {
  const cmp = await gh(`repos/${repo}/compare/${encodeURIComponent(pr.base.ref)}...${pr.head.sha}`);
  if (cmp.total_commits > cmp.commits.length) return { ok: false, title: `back-merge: compare API ให้แค่ ${cmp.commits.length} จาก ${cmp.total_commits} commit จึงตรวจไม่ครบ`, lines: [] };
  const commits = await Promise.all(
    cmp.commits.map(async (c) => ({
      sha: c.sha,
      parents: c.parents.length,
      onMain: await containsCommit(repo, "main", c.sha),
      githubMerge: c.parents.length >= 2 && c.committer?.login === "web-flow" && c.commit.verification?.verified === true,
      // The server also adds the push sender of every commit (§1J); the prototype only sees author and committer.
      people: [c.author?.login, c.committer?.login].filter((l) => l && l !== "web-flow"),
    })),
  );
  const rt = await reviewsAndTeams(repo, pr);
  return evaluateBackMerge({
    commits,
    opener: pr.user.login,
    approvers: engineers(currentApprovers(rt.reviews, pr.head.sha, pr.user.login), rt.teams),
    lockedProblems: evaluateLocked({ ...rt, author: pr.user.login, headSha: pr.head.sha }),
  });
}

async function developVerdict(repo, pr) {
  const [ac, rt] = await Promise.all([acFacts(pr), reviewsAndTeams(repo, pr)]);
  const verdict = evaluateAc(ac);
  const locked = evaluateLocked({ ...rt, author: pr.user.login, headSha: pr.head.sha });
  if (locked.length === 0) return verdict;
  return { ok: false, title: verdict.ok ? "test ล็อกยังไม่มีคนอนุมัติตามตาราง §1J" : verdict.title, lines: [...verdict.lines, ...locked.map((l) => `✗ ${l}`)] };
}

const [repo, arg, goLiveBranch] = process.argv.slice(2);
const usage = () => {
  console.error("usage: node run.mjs <owner/repo> <pr-number> | node run.mjs <owner/repo> --go-live <hotfix/x|release/r-x>");
  process.exit(2);
};
if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? "")) usage();

let verdict;
if (arg === "--go-live") {
  if (!/^(hotfix\/[\w.-]+|release\/r-[\w.-]+)$/.test(goLiveBranch ?? "")) usage();
  verdict = evaluateGoLive(goLiveBranch, (await baseFacts(repo, goLiveBranch)).base);
} else {
  if (!/^\d+$/.test(arg ?? "")) usage();
  const pr = await gh(`repos/${repo}/pulls/${arg}`);
  const r = route({ baseRef: pr.base.ref, headRef: pr.head.ref, headRepo: pr.head.repo?.full_name ?? "", repo });
  verdict = r.error
    ? { ok: false, title: r.error, lines: [] }
    : process.env.CHECK_NAME && process.env.CHECK_NAME !== r.check
      ? { ok: false, title: `ผลนี้ต้องออกในชื่อ ${r.check} ไม่ใช่ ${process.env.CHECK_NAME}`, lines: [] }
      : r.mode === "hotfix"
        ? evaluateHotfix(await hotfixFacts(repo, pr))
        : r.mode === "back-merge"
          ? await backMergeVerdict(repo, pr)
          : r.mode === "release"
            ? { ok: true, title: `${pr.head.ref} → ${pr.base.ref} ตามเส้นทาง`, lines: [] }
            : await developVerdict(repo, pr);
}
console.log(`${verdict.ok ? "PASS" : "FAIL"} ${verdict.title}`);
for (const l of verdict.lines) console.log(l);
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import("node:fs");
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ${verdict.ok ? "ผ่าน" : "ไม่ผ่าน"}: ${verdict.title}\n\n${verdict.lines.map((l) => `- ${l}`).join("\n")}\n`);
}
process.exit(verdict.ok ? 0 : 1);
