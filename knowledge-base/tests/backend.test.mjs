import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { createVaultApi, constantTimeEqual, PASSWORD_ITERATIONS } from "../app/lib/vault-api.ts";

const origin = "https://vault.example";
const pass = "a-long-test-only-password";
const sample = { title: "Test note", content: "Private test content", notebook: "Inbox", tags: ["test"], favorite: false, archived: false };
const users = {
  a: { userId: "user-a", displayName: "Test A", email: "a@example.test" },
  b: { userId: "user-b", displayName: "Test B", email: "b@example.test" },
};
function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const file of readdirSync(new URL("../drizzle/", import.meta.url)).filter((name) => name.endsWith(".sql")).sort()) sqlite.exec(readFileSync(new URL(`../drizzle/${file}`, import.meta.url), "utf8"));
  class Statement {
    constructor(sql, values = []) { this.sql = sql; this.values = values; }
    bind(...values) { return new Statement(this.sql, values); }
    async first() { return sqlite.prepare(this.sql).get(...this.values) ?? null; }
    async all() { return { results: sqlite.prepare(this.sql).all(...this.values) }; }
    async run() { return { meta: { changes: Number(sqlite.prepare(this.sql).run(...this.values).changes) } }; }
  }
  const database = {
    prepare(sql) { return new Statement(sql); },
    async batch(statements) {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map((statement) => ({ meta: { changes: Number(sqlite.prepare(statement.sql).run(...statement.values).changes) } }));
        sqlite.exec("COMMIT"); return results;
      }
      catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
  };
  let user = users.a;
  let time = 1_800_000_000_000;
  const api = createVaultApi({ getUser: async () => user, getDatabase: () => database, now: () => time });
  return { api, sqlite, setUser(value) { user = value; }, advance(ms) { time += ms; } };
}
function request(method = "GET", data, cookie, requestOrigin = origin) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (method !== "GET") { headers["content-type"] = "application/json"; if (requestOrigin !== undefined && requestOrigin !== null) headers.origin = requestOrigin; }
  return new Request(`${origin}/api/test`, { method, headers, body: data === undefined ? undefined : JSON.stringify(data) });
}
function cookie(response) { return response.headers.get("set-cookie")?.split(";")[0]; }
async function setup(f) {
  const response = await f.api.postVault(request("POST", { action: "setup", password: pass }));
  assert.equal(response.status, 200, await response.clone().text());
  return cookie(response);
}
function privateResponse(response) { assert.match(response.headers.get("cache-control"), /private/); assert.match(response.headers.get("cache-control"), /no-store/); }

test("every API rejects absent platform identity before accessing data", async () => {
  let dataAccesses = 0;
  const api = createVaultApi({ getUser: async () => null, getDatabase: () => { dataAccesses++; throw Error("must not access DB"); } });
  const results = await Promise.all([
    api.getVault(request()), api.postVault(request("POST", { action: "setup", password: pass })),
    api.getNotes(request()), api.postNotes(request("POST", sample)), api.putNote(request("PUT", sample), "id"),
    api.deleteNote(request("DELETE"), "id"), api.getBackup(request()), api.postBackup(request("POST", {})),
  ]);
  for (const response of results) { assert.equal(response.status, 401); privateResponse(response); }
  assert.equal(dataAccesses, 0);
});

test("setup creates only private guides, stores a salted hash and hashed eight-hour session", async () => {
  const f = fixture();
  assert.deepEqual(await (await f.api.getVault(request())).json(), { configured: false, unlocked: false, user: { displayName: users.a.displayName, email: users.a.email } });
  assert.equal(f.sqlite.prepare("SELECT count(*) count FROM notes").get().count, 0);
  assert.equal((await f.api.postVault(request("POST", { action: "setup", password: "too short" }))).status, 400);
  const response = await f.api.postVault(request("POST", { action: "setup", password: pass }));
  assert.equal(response.status, 200);
  const header = response.headers.get("set-cookie");
  assert.match(header, /HttpOnly/); assert.match(header, /SameSite=Strict/); assert.match(header, /Secure/); assert.match(header, /Max-Age=28800/);
  const vault = f.sqlite.prepare("SELECT * FROM vaults").get();
  assert.equal(vault.iterations, PASSWORD_ITERATIONS); assert.equal(vault.password_hash.length, 64); assert.equal(vault.password_salt.length, 64); assert.notEqual(vault.password_hash, pass);
  const session = f.sqlite.prepare("SELECT * FROM vault_sessions").get();
  assert.equal(session.expires_at - session.created_at, 8 * 60 * 60 * 1000);
  assert.notEqual(session.token_hash, cookie(response).split("=")[1]);
  const state = await (await f.api.getVault(request("GET", undefined, cookie(response)))).json();
  assert.equal(state.unlocked, true); assert.deepEqual(Object.keys(state).sort(), ["configured", "unlocked", "user"]);
  const notes = await (await f.api.getNotes(request("GET", undefined, cookie(response)))).json();
  assert.equal(notes.notes.length, 3); assert.match(notes.notes[0].notebook, /入门指南/);
  assert.equal((await f.api.postVault(request("POST", { action: "setup", password: pass }))).status, 409);
  assert.equal(f.sqlite.prepare("SELECT count(*) count FROM notes").get().count, 3);
  f.sqlite.close();
});

test("all note and backup operations require an unlocked session", async () => {
  const f = fixture(); await setup(f);
  for (const response of await Promise.all([
    f.api.getNotes(request()), f.api.postNotes(request("POST", sample)), f.api.putNote(request("PUT", sample), "id"),
    f.api.deleteNote(request("DELETE"), "id"), f.api.getBackup(request()), f.api.postBackup(request("POST", {})),
  ])) { assert.equal(response.status, 423); privateResponse(response); }
  f.sqlite.close();
});

test("mutations reject missing and forged origins, with private errors", async () => {
  const f = fixture(); const session = await setup(f);
  for (const foreign of [null, "https://attacker.example", "null"]) {
    for (const response of await Promise.all([
      f.api.postVault(request("POST", { action: "lock" }, session, foreign)),
      f.api.postNotes(request("POST", sample, session, foreign)), f.api.putNote(request("PUT", sample, session, foreign), "id"),
      f.api.deleteNote(request("DELETE", undefined, session, foreign), "id"), f.api.postBackup(request("POST", {}, session, foreign)),
    ])) { assert.equal(response.status, 403); privateResponse(response); }
  }
  const malformed = new Request(`${origin}/api/vault`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: "{" });
  const response = await f.api.postVault(malformed); assert.equal(response.status, 400); privateResponse(response);
  f.sqlite.close();
});

test("persistent throttle allows five failures and resets after ten minutes", async () => {
  const f = fixture(); await setup(f);
  for (let index = 0; index < 5; index++) assert.equal((await f.api.postVault(request("POST", { action: "unlock", password: "wrong-password" }))).status, 401);
  const denied = await f.api.postVault(request("POST", { action: "unlock", password: pass }));
  assert.equal(denied.status, 429); assert.equal(denied.headers.get("retry-after"), "600");
  f.advance(10 * 60 * 1000 + 1);
  assert.equal((await f.api.postVault(request("POST", { action: "unlock", password: pass }))).status, 200);
  f.sqlite.close();
});

test("tokens expire, bind to account identity, and lock revokes the session", async () => {
  const f = fixture(); const aSession = await setup(f);
  f.setUser(users.b); assert.equal((await f.api.getNotes(request("GET", undefined, aSession))).status, 423);
  f.setUser(users.a);
  await f.api.postVault(request("POST", { action: "lock" }, aSession));
  assert.equal((await f.api.getNotes(request("GET", undefined, aSession))).status, 423);
  const fresh = cookie(await f.api.postVault(request("POST", { action: "unlock", password: pass })));
  f.advance(8 * 60 * 60 * 1000);
  assert.equal((await f.api.getNotes(request("GET", undefined, fresh))).status, 423);
  assert.equal((await f.api.getBackup(request("GET", undefined, fresh))).status, 423);
  f.sqlite.close();
});

test("password changes require current password, revoke old cookies, and replace the session", async () => {
  const f = fixture(); const first = await setup(f);
  const second = cookie(await f.api.postVault(request("POST", { action: "unlock", password: pass })));
  assert.equal((await f.api.postVault(request("POST", { action: "change-password", password: "incorrect", newPassword: "a-new-test-only-password" }, first))).status, 401);
  const changed = await f.api.postVault(request("POST", { action: "change-password", password: pass, newPassword: "a-new-test-only-password" }, first));
  assert.equal(changed.status, 200);
  for (const old of [first, second]) assert.equal((await f.api.getNotes(request("GET", undefined, old))).status, 423);
  assert.equal((await f.api.getNotes(request("GET", undefined, cookie(changed)))).status, 200);
  assert.equal((await f.api.postVault(request("POST", { action: "unlock", password: pass }))).status, 401);
  assert.equal((await f.api.postVault(request("POST", { action: "unlock", password: "a-new-test-only-password" }))).status, 200);
  f.sqlite.close();
});

test("notes enforce user ownership, optimistic conflicts and archived-only deletion", async () => {
  const f = fixture(); const aSession = await setup(f);
  const created = await f.api.postNotes(request("POST", sample, aSession)); assert.equal(created.status, 201);
  const { note } = await created.json();
  f.setUser(users.b); const bSession = await setup(f);
  assert.equal((await f.api.putNote(request("PUT", { ...sample, expectedUpdatedAt: note.updatedAt }, bSession), note.id)).status, 404);
  assert.equal((await f.api.deleteNote(request("DELETE", undefined, bSession), note.id)).status, 404);
  assert.equal((await (await f.api.getNotes(request("GET", undefined, bSession))).json()).notes.some((item) => item.id === note.id), false);
  f.setUser(users.a);
  assert.equal((await f.api.deleteNote(request("DELETE", undefined, aSession), note.id)).status, 409);
  const updated = await f.api.putNote(request("PUT", { ...sample, title: "Updated", expectedUpdatedAt: note.updatedAt }, aSession), note.id); assert.equal(updated.status, 200);
  assert.equal((await f.api.putNote(request("PUT", { ...sample, expectedUpdatedAt: note.updatedAt }, aSession), note.id)).status, 409);
  const revised = (await updated.json()).note;
  assert.equal((await f.api.putNote(request("PUT", { ...sample, archived: true, expectedUpdatedAt: revised.updatedAt }, aSession), note.id)).status, 200);
  assert.equal((await f.api.deleteNote(request("DELETE", undefined, aSession), note.id)).status, 200);
  f.sqlite.close();
});

test("backup import validates before writing, adds new IDs and does not overwrite", async () => {
  const f = fixture(); const session = await setup(f);
  const exported = await (await f.api.getBackup(request("GET", undefined, session))).json();
  const invalid = { ...exported, notes: [exported.notes[0], { ...exported.notes[1], title: "x".repeat(201) }] };
  assert.equal((await f.api.postBackup(request("POST", invalid, session))).status, 400);
  assert.equal(f.sqlite.prepare("SELECT count(*) count FROM notes").get().count, 3);
  const invalidTime = { ...exported, notes: [{ ...exported.notes[0], createdAt: Number.MAX_SAFE_INTEGER, updatedAt: Number.MAX_SAFE_INTEGER }] };
  assert.equal((await f.api.postBackup(request("POST", invalidTime, session))).status, 400);
  assert.equal(f.sqlite.prepare("SELECT count(*) count FROM notes").get().count, 3);
  const imported = await f.api.postBackup(request("POST", exported, session)); assert.equal(imported.status, 200); assert.equal((await imported.json()).imported, 3);
  const notes = (await (await f.api.getNotes(request("GET", undefined, session))).json()).notes;
  assert.equal(notes.length, 6); assert.equal(new Set(notes.map((note) => note.id)).size, 6);
  assert.equal(notes.filter((note) => exported.notes.some((original) => original.id === note.id)).length, 3);
  assert.equal((await f.api.postBackup(request("POST", { ...exported, notes: Array(501).fill(exported.notes[0]) }, session))).status, 400);
  const tooLarge = new Request(`${origin}/api/backup`, { method: "POST", headers: { origin, cookie: session, "content-type": "application/json", "content-length": String(5 * 1024 * 1024 + 1) }, body: "{}" });
  assert.equal((await f.api.postBackup(tooLarge)).status, 413);
  f.sqlite.close();
});

test("constant-time helper compares fixed-size hashes without early match shortcuts", () => {
  assert.equal(constantTimeEqual("ab".repeat(32), "ab".repeat(32)), true);
  assert.equal(constantTimeEqual("ab".repeat(32), "ac".repeat(32)), false);
  assert.equal(constantTimeEqual("a", "aa"), false);
});

test("concurrent setup commits exactly one vault, three guides and one session", async () => {
  const f = fixture();
  const results = await Promise.all(Array.from({ length: 3 }, () => f.api.postVault(request("POST", { action: "setup", password: pass }))));
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409, 409]);
  assert.equal(f.sqlite.prepare("SELECT count(*) count FROM vaults").get().count, 1);
  assert.equal(f.sqlite.prepare("SELECT count(*) count FROM notes").get().count, 3);
  assert.equal(f.sqlite.prepare("SELECT count(*) count FROM vault_sessions").get().count, 1);
  f.sqlite.close();
});

test("concurrent failed unlocks cannot exceed the persistent five-attempt limit", async () => {
  const f = fixture(); await setup(f);
  const results = await Promise.all(Array.from({ length: 8 }, () => f.api.postVault(request("POST", { action: "unlock", password: "incorrect-password" }))));
  assert.equal(results.filter((response) => response.status === 401).length, 5);
  assert.equal(results.filter((response) => response.status === 429).length, 3);
  assert.equal(f.sqlite.prepare("SELECT attempts FROM vault_attempts").get().attempts, 5);
  f.sqlite.close();
});

test("password-change race cannot leave a session for an obsolete password version", async () => {
  const f = fixture(); const original = await setup(f);
  const [changed, concurrentUnlock] = await Promise.all([
    f.api.postVault(request("POST", { action: "change-password", password: pass, newPassword: "a-new-test-only-password" }, original)),
    f.api.postVault(request("POST", { action: "unlock", password: pass })),
  ]);
  assert.equal(changed.status, 200);
  assert.ok([200, 409].includes(concurrentUnlock.status));
  if (concurrentUnlock.status === 200) assert.equal((await f.api.getNotes(request("GET", undefined, cookie(concurrentUnlock)))).status, 423);
  assert.equal(f.sqlite.prepare("SELECT count(*) count FROM vault_sessions s JOIN vaults v ON v.user_id = s.user_id WHERE s.vault_version != v.password_version").get().count, 0);
  assert.equal((await f.api.getNotes(request("GET", undefined, cookie(changed)))).status, 200);
  f.sqlite.close();
});

test("a storage failure rolls back the entire imported batch", async () => {
  const f = fixture(); const session = await setup(f);
  const exported = await (await f.api.getBackup(request("GET", undefined, session))).json();
  f.sqlite.exec("CREATE TRIGGER reject_bad_import BEFORE INSERT ON notes WHEN NEW.title = 'Reject this note' BEGIN SELECT RAISE(ABORT, 'test import failure'); END");
  const response = await f.api.postBackup(request("POST", { ...exported, notes: [exported.notes[0], { ...exported.notes[1], title: "Reject this note" }] }, session));
  assert.equal(response.status, 500); privateResponse(response);
  assert.equal(f.sqlite.prepare("SELECT count(*) count FROM notes").get().count, 3);
  f.sqlite.close();
});

test("size validation counts streamed bytes without trusting Content-Length", async () => {
  const f = fixture(); const session = await setup(f);
  const oversized = new Request(`${origin}/api/backup`, { method: "POST", headers: { origin, cookie: session, "content-type": "application/json" }, body: " ".repeat(5 * 1024 * 1024 + 1) });
  const response = await f.api.postBackup(oversized);
  assert.equal(response.status, 413); privateResponse(response);
  f.sqlite.close();
});
