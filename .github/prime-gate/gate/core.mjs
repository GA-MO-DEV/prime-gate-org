// Prototype of the prime-gate rules as pure functions over facts collected from GitHub, the hub and the relay.
// Prototype only: the real gate is a check run the server computes (process §1J).
import { createHash } from "node:crypto";

/** Same rule as prime's acHash (plugins/prime/cli/src/feature.ts): sha256 of the Given/When/Then/And/But lines, first 8 hex. */
export function acHash(text) {
  const body = text
    .filter((l) => /^(Given|When|Then|And|But)\b/.test(l))
    .map((l) => l.replace(/\s+/g, " "))
    .join("\n");
  return createHash("sha256").update(body).digest("hex").slice(0, 8);
}

/** `### AC-01 title` blocks: `- key: value` fields right under the heading, then text. Port of prime's parseItems. */
export function parseItems(markdown, prefix) {
  const items = [];
  let current = null;
  let inFields = false;
  const heading = new RegExp(`^###\\s+(${prefix}-\\d+)\\b\\s*(.*)$`);
  for (const line of markdown.replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n/)) {
    const h = heading.exec(line);
    if (h) {
      current = { id: h[1], fields: {}, text: [] };
      items.push(current);
      inFields = true;
      continue;
    }
    if (/^#{1,3}\s/.test(line)) {
      current = null;
      continue;
    }
    if (!current) continue;
    const field = /^-\s+([a-z_]+):\s*(.*)$/.exec(line);
    if (inFields && field) {
      current.fields[field[1]] = field[2].replace(/\s+#.*$/, "").trim().replace(/^(["'])(.*)\1$/, "$2");
      continue;
    }
    if (line.trim() === "" && current.text.length === 0) {
      if (Object.keys(current.fields).length > 0) inFields = false;
      continue;
    }
    inFields = false;
    if (line.trim() !== "") current.text.push(line.trim());
  }
  return items;
}

/** `- <name>: a, b` lines, used by team.md (`- qa: GA-MO`) and plan.md (`- S-01: AC-01, AC-02`). */
export function parseListMap(markdown) {
  const map = new Map();
  for (const line of markdown.replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n/)) {
    const m = /^-\s+([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    if (map.has(m[1])) throw new Error(`ซ้ำ: ${m[1]} มีสองบรรทัด`);
    map.set(m[1], m[2].split(",").map((s) => s.trim()).filter(Boolean));
  }
  return map;
}

const SLICE_REF = /^agent\/([a-z0-9]+(?:-[a-z0-9]+)*)\/(S-\d{2})$/;

/** `agent/<feature>/S-01` → { feature, slice }. Anything else is not a slice branch. */
export function parseSliceRef(ref) {
  const m = SLICE_REF.exec(ref);
  return m ? { feature: m[1], slice: m[2] } : null;
}

/**
 * Per-AC approval gate. An AC passes only when its text still hashes to the hash a confirmed approval named.
 * facts: { slice, planMd, specMd, approvals: [{ id, status, affects: ["AC-01@abcd1234"] }], holds: ["AC-02"] }
 */
export function evaluateAc(facts) {
  const fail = (title, lines = []) => ({ ok: false, title, lines });
  if (!facts.slice) return fail("ไม่รู้ว่า PR นี้ครอบ AC ไหน", ["ชื่อ branch ต้องเป็น agent/<feature>/S-<nn> ตาม plan.md"]);
  const plan = parseListMap(facts.planMd);
  const acIds = plan.get(facts.slice.slice);
  if (!acIds || acIds.length === 0) return fail(`ไม่มี ${facts.slice.slice} ใน plan.md ของ ${facts.slice.feature}`);

  const specAcs = new Map(parseItems(facts.specMd, "AC").map((a) => [a.id, a]));
  const approved = new Map();
  for (const a of facts.approvals) {
    if (a.status !== "confirmed") continue;
    for (const unit of a.affects) {
      const [id, hash] = unit.split("@");
      if (!id || !hash) continue;
      approved.set(id, [...(approved.get(id) ?? []), { hash, by: a.id }]);
    }
  }
  const holds = new Set(facts.holds);

  const lines = acIds.map((id) => {
    const ac = specAcs.get(id);
    if (!ac) return { id, ok: false, why: "ไม่มีใน spec" };
    const current = acHash(ac.text);
    if (ac.fields.hash !== current) return { id, ok: false, why: `hash ใน spec (${ac.fields.hash || "ว่าง"}) ไม่ตรงข้อความ (${current})` };
    if (holds.has(id)) return { id, ok: false, why: "hold" };
    const match = (approved.get(id) ?? []).find((x) => x.hash === current);
    if (match) return { id, ok: true, why: `approved ${id}@${current} (${match.by})` };
    if (approved.has(id)) return { id, ok: false, why: `stale: อนุมัติไว้ที่ ${approved.get(id).map((x) => x.hash).join(", ")} ตอนนี้ ${current}` };
    return { id, ok: false, why: "ยังไม่อนุมัติ" };
  });
  const bad = lines.filter((l) => !l.ok);
  return {
    ok: bad.length === 0,
    title: bad.length === 0 ? `AC ของ ${facts.slice.slice} อนุมัติครบ ${lines.length} ข้อ` : `AC ไม่พร้อม ${bad.length} จาก ${lines.length} ข้อ`,
    lines: lines.map((l) => `${l.ok ? "✓" : "✗"} ${l.id}: ${l.why}`),
  };
}

/** CODEOWNERS lines → [{ pattern, owners }]. Last matching pattern wins, as on GitHub. */
export function parseCodeowners(text) {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*$/, "").trim())
    .filter(Boolean)
    .map((l) => {
      const [pattern, ...owners] = l.split(/\s+/);
      return { pattern, owners };
    });
}

function globToRegex(pattern) {
  const anchored = pattern.startsWith("/");
  let p = anchored ? pattern.slice(1) : pattern;
  const dir = p.endsWith("/");
  if (dir) p = p.slice(0, -1);
  const body = p
    .split("")
    .map((c, i, all) => {
      if (c === "*") return all[i + 1] === "*" ? "" : all[i - 1] === "*" ? ".*" : "[^/]*";
      return /[.+?^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
    })
    .join("");
  return new RegExp(`${anchored || p.includes("/") ? "^" : "(^|/)"}${body}${dir ? "/" : "(/|$)"}`);
}

export function ownersOf(rules, path) {
  let owners = [];
  for (const r of rules) if (globToRegex(r.pattern).test(path)) owners = r.owners;
  return owners;
}

const LOCKED = /^tests\/locked\//;
const CONTROL = [/^\.github\//, /^CODEOWNERS$/, /^docs\/CODEOWNERS$/, /^db\/migrations\//, /^tier-rules\.yml$/];

/**
 * Hotfix mode of the gate (process §8 H4, the four 2b items).
 * facts: {
 *   author, headSha, incidentId,
 *   incident: { ok, why },                         // relay-signed incident record, verified by the caller
 *   base: { mainTag, mainIsAncestor, foreign: [sha] }, // r-* tag at main HEAD, main reachable from the hotfix branch, commits not from hotfix PRs
 *   files: [{ filename, previous_filename? }],
 *   codeowners: string,                            // CODEOWNERS at the base SHA
 *   reviews: [{ login, state, commit_id }],
 *   teams: Map<team, logins[]>,                    // team.md from the hub
 *   org: "GA-MO-DEV",
 * }
 */
export function evaluateHotfix(f) {
  const problems = [];
  const notes = [];
  if (!f.incident.ok) problems.push(`incident ${f.incidentId}: ${f.incident.why}`);
  if (!f.base.mainTag) problems.push("main HEAD ไม่มี tag r-* จึงไม่รู้ว่า production คือ release ไหน");
  if (!f.base.mainIsAncestor) problems.push("branch hotfix ไม่ได้แตกจาก main HEAD (fast-forward main ไม่ได้)");
  if (f.base.foreign.length > 0) problems.push(`branch มี commit ที่ไม่ได้มาจาก PR เข้า branch นี้: ${f.base.foreign.map((s) => s.slice(0, 7)).join(", ")}`);

  const approvers = new Set(
    f.reviews.filter((r) => r.state === "APPROVED" && r.commit_id === f.headSha && r.login !== f.author).map((r) => r.login),
  );
  if (approvers.size === 0) problems.push("ต้องมี engineer คนที่สองอนุมัติที่ head SHA (คนเปิด PR ไม่นับ)");

  const rules = parseCodeowners(f.codeowners);
  const teamOf = (owner) => owner.replace(new RegExp(`^@${f.org}/`, "i"), "");
  const inTeam = (team, login) => (f.teams.get(team) ?? []).includes(login);
  const oncall = [...approvers].filter((l) => inTeam("oncall", l));

  const paths = new Set(f.files.flatMap((x) => [x.filename, x.previous_filename].filter(Boolean)));
  for (const path of paths) {
    if (LOCKED.test(path)) {
      problems.push(`${path}: hotfix แก้ test ล็อกไม่ได้ (§17 ข้อ 63) ไปทาง flow ปกติ`);
      continue;
    }
    const owners = ownersOf(rules, path).map(teamOf);
    const control = CONTROL.some((re) => re.test(path));
    if (owners.length === 0 && !control) continue;
    const realOwner = [...approvers].some((l) => owners.some((t) => inTeam(t, l)));
    if (realOwner) continue;
    if (control) problems.push(`${path}: path ควบคุม ต้องมี code owner ตัวจริง (${owners.join(", ") || "ไม่มีใน CODEOWNERS"}) break-glass ไม่ครอบ`);
    else if (oncall.length > 0) notes.push(`${path}: break-glass โดย ${oncall.join(", ")} แทน ${owners.join(", ")} · code owner ทบทวนใน H6`);
    else problems.push(`${path}: ต้องมี code owner (${owners.join(", ")}) หรือคนในเวรอนุมัติ (break-glass)`);
  }
  return {
    ok: problems.length === 0,
    title: problems.length === 0 ? `hotfix ${f.incidentId} ผ่าน` : `hotfix ${f.incidentId} ไม่ผ่าน ${problems.length} ข้อ`,
    lines: [...problems.map((p) => `✗ ${p}`), ...notes.map((n) => `! ${n}`)],
  };
}

# rt fake
