import { DurableObject } from "cloudflare:workers";

const MAX_NAME = 30;
const MAX_TOPIC = 120;
const MAX_PARTICIPANTS = 500;

export class Lottery extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        this.sql = ctx.storage.sql;
        this.sql.exec(`
      CREATE TABLE IF NOT EXISTS participants (
        id          TEXT PRIMARY KEY,
        token_hash  TEXT NOT NULL UNIQUE,
        name        TEXT NOT NULL,
        topic       TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        assigned_id TEXT
      );
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    `);
    }

    #drawnAt() {
        const row = this.sql.exec("SELECT value FROM meta WHERE key = 'drawn_at'").toArray()[0];
        return row ? Number(row.value) : null;
    }

    #showEntry() {
        const row = this.sql.exec("SELECT value FROM meta WHERE key = 'show_entry'").toArray()[0];
        return row?.value === "1";
    }

    #count() {
        return this.sql.exec("SELECT COUNT(*) AS n FROM participants").one().n;
    }

    #byToken(tokenHash) {
        if (!tokenHash) return null;
        return this.sql.exec("SELECT * FROM participants WHERE token_hash = ?", tokenHash).toArray()[0] ?? null;
    }

    me(tokenHash) {
        const drawnAt = this.#drawnAt();
        const p = this.#byToken(tokenHash);
        const out = { count: this.#count(), drawn: drawnAt !== null, showEntry: this.#showEntry(), registered: !!p };
        if (p) {
            out.name = p.name;
            out.topic = p.topic;
            if (drawnAt !== null && p.assigned_id) {
                const t = this.sql.exec("SELECT topic FROM participants WHERE id = ?", p.assigned_id).toArray()[0];
                out.result = t ? t.topic : null;
            }
        }
        return out;
    }

    register(tokenHash, newTokenHash, name, topic) {
        if (this.#drawnAt() !== null) return { error: "已經抽過籤了，登記已關閉", status: 409 };
        const p = this.#byToken(tokenHash);
        if (p) {
            this.sql.exec("UPDATE participants SET name = ?, topic = ? WHERE id = ?", name, topic, p.id);
            return { ok: true, created: false };
        }
        if (this.#count() >= MAX_PARTICIPANTS) return { error: "人數已滿", status: 409 };
        this.sql.exec(
            "INSERT INTO participants (id, token_hash, name, topic, created_at) VALUES (?, ?, ?, ?, ?)",
            crypto.randomUUID(), newTokenHash, name, topic, Date.now(),
        );
        return { ok: true, created: true };
    }

    adminState() {
        const rows = this.sql.exec(`
      SELECT p.id, p.name, p.topic, p.created_at, a.topic AS result, a.name AS result_from
      FROM participants p LEFT JOIN participants a ON a.id = p.assigned_id
      ORDER BY p.created_at
    `).toArray();
        return {
            drawnAt: this.#drawnAt(),
            showEntry: this.#showEntry(),
            participants: rows.map((r) => ({
                id: r.id, name: r.name, topic: r.topic, createdAt: r.created_at,
                result: r.result ?? null, resultFrom: r.result_from ?? null,
            })),
        };
    }

    draw() {
        const ids = this.sql.exec("SELECT id FROM participants ORDER BY created_at").toArray().map((r) => r.id);
        if (ids.length < 2) return { error: "至少要 2 個人才能抽籤", status: 400 };
        const perm = randomDerangement(ids.length);
        this.ctx.storage.transactionSync(() => {
            ids.forEach((id, i) => this.sql.exec("UPDATE participants SET assigned_id = ? WHERE id = ?", ids[perm[i]], id));
            this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('drawn_at', ?)", String(Date.now()));
        });
        return { ok: true };
    }

    reset() {
        this.ctx.storage.transactionSync(() => {
            this.sql.exec("UPDATE participants SET assigned_id = NULL");
            this.sql.exec("DELETE FROM meta WHERE key = 'drawn_at'");
        });
        return { ok: true };
    }

    remove(id) {
        if (this.#drawnAt() !== null) return { error: "請先撤銷抽籤再刪除", status: 409 };
        this.sql.exec("DELETE FROM participants WHERE id = ?", id);
        return { ok: true };
    }

    clearAll() {
        this.ctx.storage.transactionSync(() => {
            this.sql.exec("DELETE FROM participants");
            this.sql.exec("DELETE FROM meta WHERE key = 'drawn_at'");
        });
        return { ok: true };
    }

    setShowEntry(show) {
        this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('show_entry', ?)", show ? "1" : "0");
        return { ok: true };
    }
}

function randomInt(n) {
    const limit = Math.floor(0x1_0000_0000 / n) * n;
    const buf = new Uint32Array(1);
    do crypto.getRandomValues(buf); while (buf[0] >= limit);
    return buf[0] % n;
}

function randomDerangement(n) {
    for (; ;) {
        const a = Array.from({ length: n }, (_, i) => i);
        for (let i = n - 1; i > 0; i--) {
            const j = randomInt(i + 1);
            [a[i], a[j]] = [a[j], a[i]];
        }
        if (a.every((v, i) => v !== i)) return a;
    }
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const path = url.pathname;
        const stub = env.LOTTERY.get(env.LOTTERY.idFromName("main"));

        try {
            if (path.startsWith("/api/")) return await publicApi(request, path, stub);
            if (path.startsWith("/admin/api/")) return await adminApi(request, path, stub);

            return env.ASSETS.fetch(request);
        } catch (err) {
            if (err instanceof HttpError) return json({ error: err.message }, err.status);
            console.error(err);
            return json({ error: "Internal error" }, 500);
        }
    },
};

async function publicApi(request, path, stub) {
    const tokenHash = await bearerHash(request);

    if (path === "/api/me" && request.method === "GET") {
        return json(await stub.me(tokenHash), 200, { "Cache-Control": "no-store" });
    }

    if (path === "/api/register" && request.method === "POST") {
        const body = await readJson(request);
        const name = clean(body.name, MAX_NAME);
        const topic = clean(body.topic, MAX_TOPIC);
        if (!name || !topic) throw new HttpError(400, "名字和主題都要填");

        const newToken = randomToken();
        const res = await stub.register(tokenHash, await sha256(newToken), name, topic);
        if (res.error) throw new HttpError(res.status, res.error);
        return json(res.created ? { ok: true, token: newToken } : { ok: true });
    }

    throw new HttpError(404, "Not found");
}

async function adminApi(request, path, stub) {
    if (path === "/admin/api/state" && request.method === "GET") {
        return json(await stub.adminState(), 200, { "Cache-Control": "no-store" });
    }
    if (request.method !== "POST") throw new HttpError(404, "Not found");

    const body = await readJson(request);
    let res;
    switch (path) {
        case "/admin/api/draw": res = await stub.draw(); break;
        case "/admin/api/reset": res = await stub.reset(); break;
        case "/admin/api/delete": res = await stub.remove(String(body.id ?? "")); break;
        case "/admin/api/clear": res = await stub.clearAll(); break;
        case "/admin/api/entry": res = await stub.setShowEntry(body.show === true); break;
        default: throw new HttpError(404, "Not found");
    }
    if (res.error) throw new HttpError(res.status, res.error);
    return json(res);
}

class HttpError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}

function json(data, status = 200, headers = {}) {
    return Response.json(data, { status, headers });
}

async function readJson(request) {
    if (!(request.headers.get("Content-Type") || "").includes("application/json")) {
        throw new HttpError(415, "需要 application/json");
    }
    const origin = request.headers.get("Origin");
    if (origin && origin !== new URL(request.url).origin) throw new HttpError(403, "Bad origin");
    try {
        const body = await request.json();
        return body && typeof body === "object" ? body : {};
    } catch {
        throw new HttpError(400, "JSON 格式錯誤");
    }
}

function clean(v, max) {
    return String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function randomToken() {
    const b = crypto.getRandomValues(new Uint8Array(32));
    return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(text) {
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function bearerHash(request) {
    const m = /^Bearer\s+([A-Za-z0-9_-]{20,100})$/.exec(request.headers.get("Authorization") || "");
    return m ? sha256(m[1]) : null;
}
