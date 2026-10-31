// Prototype of the relay's ack record (process §8) and how the gate server checks it. In-memory, no LINE account.
import { createHmac, generateKeyPairSync, sign, timingSafeEqual, verify } from "node:crypto";
import { createServer } from "node:http";

const ALERT = /^[A-Za-z0-9-]{1,64}$/;
const INCIDENT = /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_BODY = 64 * 1024;

const equal = (a, b) => a.length === b.length && timingSafeEqual(a, b);

/**
 * rota: LINE userIds allowed to ack, in wake-up order. serverToken: bearer the gate server sends.
 * The relay signs every incident record with its own Ed25519 key, so the server trusts the record, not the transport.
 */
export function createRelay({ channelSecret, rota, serverToken, now = () => Date.now() }) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const acks = new Map();
  const incidents = new Map();

  function onText(userId, text) {
    if (!rota.includes(userId)) return "ignored: not in rota";
    const ack = /^รับ\s+(\S+)$/.exec(text);
    if (ack) {
      if (!ALERT.test(ack[1])) return "ignored: bad alert id";
      if (!acks.has(ack[1])) acks.set(ack[1], { alertId: ack[1], ackedBy: userId, ackedAt: now() });
      return "acked";
    }
    const open = /^เปิดเหตุ\s+(\S+)\s+(\S+)$/.exec(text);
    if (open) {
      const [, id, alertId] = open;
      if (!INCIDENT.test(id)) return "ignored: bad incident id";
      const a = acks.get(alertId);
      if (!a) return "ignored: alert not acked";
      if (incidents.has(id)) return "ignored: incident exists";
      if ([...incidents.values()].some((i) => i.alertId === alertId)) return "ignored: alert already bound";
      incidents.set(id, { id, alertId, ackedBy: a.ackedBy, ackedAt: a.ackedAt, openedBy: userId, openedAt: now(), closed: false });
      return "opened";
    }
    const close = /^ปิดเหตุ\s+(\S+)$/.exec(text);
    if (close && incidents.has(close[1])) {
      incidents.get(close[1]).closed = true;
      return "closed";
    }
    return "ignored: unknown command";
  }

  /** LINE webhook: X-Line-Signature is base64 HMAC-SHA256 of the raw body with the channel secret. */
  function lineWebhook(raw, signature) {
    const expected = createHmac("sha256", channelSecret).update(raw).digest();
    let given;
    try {
      given = Buffer.from(signature ?? "", "base64");
    } catch {
      return { status: 401, body: "bad signature" };
    }
    if (!equal(expected, given)) return { status: 401, body: "bad signature" };
    let events;
    try {
      events = JSON.parse(raw.toString("utf8")).events;
    } catch {
      return { status: 400, body: "bad json" };
    }
    if (!Array.isArray(events)) return { status: 400, body: "no events" };
    const results = events.map((e) =>
      e?.type === "message" && e.message?.type === "text" && typeof e.source?.userId === "string" ? onText(e.source.userId, e.message.text.trim()) : "ignored: not a text message",
    );
    return { status: 200, body: JSON.stringify(results) };
  }

  function getIncident(id, auth) {
    const expected = Buffer.from(`Bearer ${serverToken}`);
    if (!equal(expected, Buffer.from(auth ?? ""))) return { status: 401, body: "unauthorized" };
    const record = incidents.get(id);
    if (!record) return { status: 404, body: "no such incident" };
    const payload = JSON.stringify(record);
    return { status: 200, body: JSON.stringify({ payload, sig: sign(null, Buffer.from(payload), privateKey).toString("base64") }) };
  }

  const server = createServer((req, res) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) req.destroy();
      else chunks.push(c);
    });
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://relay");
      const m = /^\/incidents\/([^/]+)$/.exec(url.pathname);
      const r =
        req.method === "POST" && url.pathname === "/line/webhook"
          ? lineWebhook(Buffer.concat(chunks), req.headers["x-line-signature"])
          : req.method === "GET" && m
            ? getIncident(decodeURIComponent(m[1]), req.headers.authorization)
            : { status: 404, body: "not found" };
      res.writeHead(r.status, { "content-type": "application/json" }).end(r.body);
    });
  });

  return { server, publicKeyPem: publicKey.export({ type: "spki", format: "pem" }) };
}

/**
 * Gate-server side: ask the relay for the incident behind `hotfix/<incidentId>` and accept it only when the relay's
 * signature holds, the record names this incident, it is open, and it was opened within the last 24 hours.
 */
export async function checkIncident({ relayUrl, serverToken, publicKeyPem, incidentId, now = Date.now(), fetchImpl = fetch }) {
  if (!INCIDENT.test(incidentId)) return { ok: false, why: `ชื่อ branch ไม่ใช่ hotfix/<yyyy-mm-dd-slug>: ${incidentId}` };
  let res;
  try {
    res = await fetchImpl(`${relayUrl}/incidents/${encodeURIComponent(incidentId)}`, { headers: { authorization: `Bearer ${serverToken}` }, signal: AbortSignal.timeout(5000) });
  } catch (e) {
    return { ok: false, why: `relay ไม่ตอบ (${e.name})` };
  }
  if (res.status === 404) return { ok: false, why: "relay ไม่มีเหตุนี้ (ยังไม่มีใครตอบรับและเปิดเหตุใน LINE เวร)" };
  if (!res.ok) return { ok: false, why: `relay ตอบ ${res.status}` };
  let body;
  try {
    body = await res.json();
  } catch {
    return { ok: false, why: "relay ตอบไม่ใช่ JSON" };
  }
  if (typeof body?.payload !== "string" || typeof body?.sig !== "string") return { ok: false, why: "relay ตอบผิดรูป" };
  if (!verify(null, Buffer.from(body.payload), publicKeyPem, Buffer.from(body.sig, "base64"))) return { ok: false, why: "ลายเซ็นของ relay ไม่ถูก" };
  const r = JSON.parse(body.payload);
  if (r.id !== incidentId) return { ok: false, why: `record เป็นของเหตุ ${r.id}` };
  if (r.closed) return { ok: false, why: "เหตุปิดแล้ว" };
  if (!(now - r.openedAt < 24 * 3600 * 1000 && r.openedAt <= now)) return { ok: false, why: "เปิดเหตุเกิน 24 ชม." };
  return { ok: true, why: `ack ${r.alertId} โดย ${r.ackedBy} · เปิดเหตุโดย ${r.openedBy}`, record: r };
}
