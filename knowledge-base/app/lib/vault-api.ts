/** Server-side authorization, storage and validation; no browser persistence. */
export type VaultUser = { userId: string; displayName: string; email: string };
export type NoteInput = {
  title: string; content: string; notebook: string; tags: string[];
  favorite: boolean; archived: boolean;
};
export type Note = NoteInput & { id: string; createdAt: number; updatedAt: number };

type Statement = {
  bind(...values: unknown[]): Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes?: number } }>;
};
export type VaultDatabase = {
  prepare(sql: string): Statement;
  batch(statements: Statement[]): Promise<{ meta: { changes?: number } }[]>;
};
type Dependencies = { getUser(): Promise<VaultUser | null>; getDatabase(): VaultDatabase; now?: () => number };
type VaultRow = { user_id: string; password_hash: string; password_salt: string; iterations: number; password_version: string };
type NoteRow = { id: string; title: string; content: string; notebook: string; tags_json: string; favorite: number; archived: number; created_at: number; updated_at: number };
const COOKIE = "kb_vault_session";
const SESSION_MS = 8 * 60 * 60 * 1000;
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
export const PASSWORD_ITERATIONS = 100_000;
const BACKUP_LIMIT = 5 * 1024 * 1024;
const textEncoder = new TextEncoder();

class ApiError extends Error {
  status: number;
  code: string;
  retryAfter?: number;
  constructor(status: number, message: string, code: string, retryAfter?: number) {
    super(message); this.status = status; this.code = code; this.retryAfter = retryAfter;
  }
}
function fail(status: number, message: string, code: string): never { throw new ApiError(status, message, code); }
function json(value: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), { status, headers: {
    "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store",
    "Pragma": "no-cache", "Vary": "Cookie", "X-Content-Type-Options": "nosniff", ...extra,
  } });
}
function hex(bytes: Uint8Array) { return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""); }
function unhex(value: string) { return new Uint8Array(value.match(/.{2}/g)!.map((part) => parseInt(part, 16))); }
function randomToken() { return hex(crypto.getRandomValues(new Uint8Array(32))); }
async function tokenHash(token: string) { return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", textEncoder.encode(token)))); }
async function passwordHash(password: string, salt: string, iterations = PASSWORD_ITERATIONS) {
  const key = await crypto.subtle.importKey("raw", textEncoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  return hex(new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: unhex(salt), iterations }, key, 256)));
}
export function constantTimeEqual(left: string, right: string) {
  const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual?: (a: Uint8Array, b: Uint8Array) => boolean };
  if (subtle.timingSafeEqual && left.length === right.length) return subtle.timingSafeEqual(textEncoder.encode(left), textEncoder.encode(right));
  let difference = left.length ^ right.length;
  // Password digests are always fixed-length hexadecimal strings.
  for (let index = 0; index < Math.max(left.length, right.length); index++) difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  return difference === 0;
}
function password(value: unknown, creating: boolean) {
  if (typeof value !== "string" || Array.from(value).length > 128 || Array.from(value).length < (creating ? 12 : 1))
    fail(400, creating ? "Use a password with 12–128 characters." : "Enter your password.", "INVALID_PASSWORD");
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(400, "Expected a JSON object.", "INVALID_INPUT");
  return value as Record<string, unknown>;
}
function boundedText(value: unknown, field: string, max: number, allowEmpty = true) {
  if (typeof value !== "string" || value.length > max || (!allowEmpty && !value.trim())) fail(400, `${field} is invalid or too long.`, "INVALID_INPUT");
  return value;
}
export function validateNote(value: unknown): NoteInput {
  const item = object(value);
  const title = boundedText(item.title, "Title", 200, false).trim();
  const content = boundedText(item.content ?? "", "Content", 100_000);
  const notebook = boundedText(item.notebook ?? "Inbox", "Notebook", 60, false).trim();
  const suppliedTags = item.tags ?? [];
  if (!Array.isArray(suppliedTags) || suppliedTags.length > 20) fail(400, "Use at most 20 tags.", "INVALID_INPUT");
  const tags = [...new Set(suppliedTags.map((tag) => boundedText(tag, "Tag", 60, false).trim()))];
  if ((item.favorite !== undefined && typeof item.favorite !== "boolean") || (item.archived !== undefined && typeof item.archived !== "boolean"))
    fail(400, "Favorite and archived must be booleans.", "INVALID_INPUT");
  return { title, content, notebook, tags, favorite: item.favorite === true, archived: item.archived === true };
}
function timestamp(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) fail(400, `${label} must be a valid timestamp.`, "INVALID_INPUT");
  return value;
}
function noteFromRow(row: NoteRow): Note {
  return { id: row.id, title: row.title, content: row.content, notebook: row.notebook, tags: JSON.parse(row.tags_json), favorite: Boolean(row.favorite), archived: Boolean(row.archived), createdAt: row.created_at, updatedAt: row.updated_at };
}
function checkOrigin(request: Request) {
  if (request.headers.get("origin") !== new URL(request.url).origin || request.headers.get("sec-fetch-site") === "cross-site")
    fail(403, "This request must come from this site.", "INVALID_ORIGIN");
}
async function body(request: Request, limit: number) {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") fail(415, "Send JSON data.", "INVALID_CONTENT_TYPE");
  const length = Number(request.headers.get("content-length"));
  if (length > limit) fail(413, "The request is too large.", "BODY_TOO_LARGE");
  const reader = request.body?.getReader();
  if (!reader) fail(400, "A JSON body is required.", "INVALID_JSON");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); fail(413, "The request is too large.", "BODY_TOO_LARGE"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return object(JSON.parse(new TextDecoder().decode(bytes))); }
  catch (error) { if (error instanceof ApiError) throw error; fail(400, "The JSON data is invalid.", "INVALID_JSON"); }
}
function cookieValue(request: Request) {
  const value = request.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  return value && /^[a-f0-9]{64}$/.test(value) ? value : null;
}
function sessionCookie(request: Request, token: string, clear = false) {
  return `${COOKIE}=${clear ? "" : token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : SESSION_MS / 1000}${new URL(request.url).protocol === "https:" ? "; Secure" : ""}`;
}
const welcomeNotes: NoteInput[] = [
  { title: "欢迎使用拾知", notebook: "入门指南", tags: ["指南"], favorite: true, archived: false,
    content: "# 从一个想法开始\n\n这是一篇使用指南，不包含导入的个人资料。你可以随时编辑、归档或删除它。\n\n点击新建笔记，给想法起一个清楚的标题，再慢慢补充内容。\n\n笔记属于当前登录的账号，知识库密码再加一道锁。离开时记得锁定知识库；解锁会话会在八小时后过期。" },
  { title: "指南：记录、整理与查找", notebook: "入门指南", tags: ["指南", "整理"], favorite: false, archived: false,
    content: "# 给知识留个位置\n\n1. 用清楚的标题概括笔记。\n2. 按主题放入笔记本。\n3. 添加少量标签，收藏常用内容。\n4. 用搜索查找标题、正文、笔记本或标签。\n\n## Markdown 小提示\n\n用 `# 标题` 创建标题，用 `- 内容` 写列表，用 `**重点**` 加粗文字。\n\n暂时不用的内容可以归档；归档后仍可恢复，也可以永久删除。" },
  { title: "指南：备份与密码", notebook: "入门指南", tags: ["指南", "备份"], favorite: false, archived: false,
    content: "# 定期留一份备份\n\n在设置中导出 JSON 备份。文件包含笔记正文和归档内容，请妥善保存在私人位置。\n\n导入会添加副本，不会覆盖现有笔记；重复导入会产生重复内容。\n\n请使用至少十二个字符的独立密码，并保存在密码管理器中。目前没有密码找回功能。修改密码后，其他解锁会话会失效。\n\n密码用于控制访问；笔记保存在网站数据库中，不是端到端加密。" },
];

export function createVaultApi(dependencies: Dependencies) {
  const now = dependencies.now ?? Date.now;
  const db = () => dependencies.getDatabase();
  const query = (sql: string, ...values: unknown[]) => db().prepare(sql).bind(...values);
  async function identity() {
    const user = await dependencies.getUser();
    if (!user) fail(401, "Sign in with ChatGPT to continue.", "SIGN_IN_REQUIRED");
    return user;
  }
  const vault = (userId: string) => query("SELECT * FROM vaults WHERE user_id = ?", userId).first<VaultRow>();
  async function unlocked(request: Request, userId: string) {
    const token = cookieValue(request);
    if (!token) return false;
    return Boolean(await query(`SELECT s.token_hash FROM vault_sessions s JOIN vaults v ON v.user_id = s.user_id AND v.password_version = s.vault_version WHERE s.token_hash = ? AND s.user_id = ? AND s.expires_at > ?`, await tokenHash(token), userId, now()).first());
  }
  async function authorize(request: Request) {
    const user = await identity();
    if (!await unlocked(request, user.userId)) fail(423, "Unlock your vault to access your notes.", "VAULT_LOCKED");
    return user;
  }
  function insertNote(userId: string, note: Note) {
    return query(`INSERT INTO notes (id, user_id, title, content, notebook, tags_json, favorite, archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, note.id, userId, note.title, note.content, note.notebook, JSON.stringify(note.tags), Number(note.favorite), Number(note.archived), note.createdAt, note.updatedAt);
  }
  async function reserveAttempt(userId: string) {
    const time = now();
    const reservation = await query(`INSERT INTO vault_attempts (user_id, window_start, attempts) VALUES (?, ?, 1) ON CONFLICT(user_id) DO UPDATE SET attempts = CASE WHEN window_start <= ? THEN 1 ELSE attempts + 1 END, window_start = CASE WHEN window_start <= ? THEN ? ELSE window_start END WHERE window_start <= ? OR attempts < 5 RETURNING attempts`, userId, time, time - ATTEMPT_WINDOW_MS, time - ATTEMPT_WINDOW_MS, time, time - ATTEMPT_WINDOW_MS).first();
    if (!reservation) {
      const state = await query("SELECT window_start FROM vault_attempts WHERE user_id = ?", userId).first<{ window_start: number }>();
      throw new ApiError(429, "Too many attempts. Please try again in a few minutes.", "TOO_MANY_ATTEMPTS", Math.max(1, Math.ceil(((state?.window_start ?? time) + ATTEMPT_WINDOW_MS - time) / 1000)));
    }
  }
  function clearAttempts(userId: string) { return query("UPDATE vault_attempts SET attempts = 0, window_start = ? WHERE user_id = ?", now(), userId); }
  function insertSession(userId: string, version: string, hash: string) {
    return query(`INSERT INTO vault_sessions (token_hash, user_id, vault_version, expires_at, created_at) SELECT ?, user_id, password_version, ?, ? FROM vaults WHERE user_id = ? AND password_version = ?`, hash, now() + SESSION_MS, now(), userId, version);
  }
  async function listNotes(userId: string) {
    return (await query("SELECT * FROM notes WHERE user_id = ? ORDER BY updated_at DESC, id", userId).all<NoteRow>()).results.map(noteFromRow);
  }
  async function safe(operation: () => Promise<Response>) {
    try { return await operation(); }
    catch (error) {
      if (error instanceof ApiError) return json({ error: error.message, code: error.code }, error.status, error.retryAfter ? { "Retry-After": String(error.retryAfter) } : {});
      // Never log request bodies, passwords, tokens, or private note contents.
      return json({ error: "The request could not be completed. Please try again.", code: "SERVER_ERROR" }, 500);
    }
  }
  return {
    getVault: (request: Request) => safe(async () => {
      const user = await identity();
      const configured = Boolean(await vault(user.userId));
      return json({ configured, unlocked: configured && await unlocked(request, user.userId), user: { displayName: user.displayName, email: user.email } });
    }),
    postVault: (request: Request) => safe(async () => {
      const user = await identity();
      checkOrigin(request);
      const input = await body(request, 2048);
      if (input.action === "lock") {
        const token = cookieValue(request);
        if (token) await query("DELETE FROM vault_sessions WHERE token_hash = ? AND user_id = ?", await tokenHash(token), user.userId).run();
        return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(request, "", true) });
      }
      if (!["setup", "unlock", "change-password"].includes(String(input.action))) fail(400, "Choose a valid vault action.", "INVALID_ACTION");
      const existing = await vault(user.userId);
      if (input.action === "setup") {
        if (existing) fail(409, "Your vault is already configured.", "ALREADY_CONFIGURED");
        const plain = password(input.password, true);
        const salt = randomToken();
        const hash = await passwordHash(plain, salt);
        const version = crypto.randomUUID();
        const token = randomToken();
        const time = now();
        try {
          await db().batch([
            query("INSERT INTO vaults (user_id, password_hash, password_salt, iterations, password_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)", user.userId, hash, salt, PASSWORD_ITERATIONS, version, time, time),
            ...welcomeNotes.map((note) => insertNote(user.userId, { ...note, id: crypto.randomUUID(), createdAt: time, updatedAt: time })),
            insertSession(user.userId, version, await tokenHash(token)),
          ]);
        } catch (error) {
          if (await vault(user.userId)) fail(409, "Your vault is already configured. Unlock it to continue.", "ALREADY_CONFIGURED");
          throw error;
        }
        return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(request, token) });
      }
      if (!existing) fail(409, "Set up your vault first.", "NOT_CONFIGURED");
      if (input.action === "change-password" && !await unlocked(request, user.userId)) fail(423, "Unlock your vault first.", "VAULT_LOCKED");
      const plain = password(input.password, false);
      const replacement = input.action === "change-password" ? password(input.newPassword, true) : null;
      await reserveAttempt(user.userId);
      if (!constantTimeEqual(await passwordHash(plain, existing.password_salt, existing.iterations), existing.password_hash)) fail(401, "The password is incorrect.", "INCORRECT_PASSWORD");
      const token = randomToken();
      const hash = await tokenHash(token);
      if (replacement !== null) {
        const salt = randomToken();
        const replacementHash = await passwordHash(replacement, salt);
        const version = crypto.randomUUID();
        const result = await db().batch([
          query("UPDATE vaults SET password_hash = ?, password_salt = ?, iterations = ?, password_version = ?, updated_at = ? WHERE user_id = ? AND password_version = ?", replacementHash, salt, PASSWORD_ITERATIONS, version, now(), user.userId, existing.password_version),
          query("DELETE FROM vault_sessions WHERE user_id = ? AND EXISTS (SELECT 1 FROM vaults WHERE user_id = ? AND password_version = ?)", user.userId, user.userId, version),
          insertSession(user.userId, version, hash), clearAttempts(user.userId),
        ]);
        if (!result[0].meta.changes) fail(409, "Your password changed in another session. Unlock again.", "VAULT_CHANGED");
      } else {
        const result = await db().batch([
          query("DELETE FROM vault_sessions WHERE user_id = ? AND expires_at <= ?", user.userId, now()),
          insertSession(user.userId, existing.password_version, hash), clearAttempts(user.userId),
        ]);
        if (!result[1].meta.changes) fail(409, "Your password changed in another session. Unlock again.", "VAULT_CHANGED");
      }
      return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(request, token) });
    }),
    getNotes: (request: Request) => safe(async () => { const user = await authorize(request); return json({ notes: await listNotes(user.userId) }); }),
    postNotes: (request: Request) => safe(async () => {
      const user = await authorize(request); checkOrigin(request);
      const input = validateNote(await body(request, 512 * 1024));
      const time = now();
      const note = { ...input, id: crypto.randomUUID(), createdAt: time, updatedAt: time };
      await insertNote(user.userId, note).run();
      return json({ note }, 201);
    }),
    putNote: (request: Request, id: string) => safe(async () => {
      const user = await authorize(request); checkOrigin(request);
      const input = await body(request, 512 * 1024);
      const note = validateNote(input);
      const expected = timestamp(input.expectedUpdatedAt, "Expected update time");
      const updatedAt = timestamp(Math.max(now(), expected + 1), "Update time");
      const row = await query(`UPDATE notes SET title = ?, content = ?, notebook = ?, tags_json = ?, favorite = ?, archived = ?, updated_at = ? WHERE id = ? AND user_id = ? AND updated_at = ? RETURNING *`, note.title, note.content, note.notebook, JSON.stringify(note.tags), Number(note.favorite), Number(note.archived), updatedAt, id, user.userId, expected).first<NoteRow>();
      if (!row) {
        if (!await query("SELECT id FROM notes WHERE id = ? AND user_id = ?", id, user.userId).first()) fail(404, "This note was not found.", "NOT_FOUND");
        fail(409, "This note changed in another session. Reload it before saving.", "NOTE_CONFLICT");
      }
      return json({ note: noteFromRow(row) });
    }),
    deleteNote: (request: Request, id: string) => safe(async () => {
      const user = await authorize(request); checkOrigin(request);
      const removed = await query("DELETE FROM notes WHERE id = ? AND user_id = ? AND archived = 1 RETURNING id", id, user.userId).first();
      if (!removed) {
        if (!await query("SELECT id FROM notes WHERE id = ? AND user_id = ?", id, user.userId).first()) fail(404, "This note was not found.", "NOT_FOUND");
        fail(409, "Archive this note before permanently deleting it.", "ARCHIVE_REQUIRED");
      }
      return json({ ok: true });
    }),
    getBackup: (request: Request) => safe(async () => {
      const user = await authorize(request);
      return json({ version: 1, exportedAt: now(), notes: await listNotes(user.userId) }, 200, { "Content-Disposition": "attachment; filename=knowledge-base-backup.json" });
    }),
    postBackup: (request: Request) => safe(async () => {
      const user = await authorize(request); checkOrigin(request);
      const input = await body(request, BACKUP_LIMIT);
      if (input.version !== 1 || !Array.isArray(input.notes) || input.notes.length > 500) fail(400, "Use a version 1 backup with at most 500 notes.", "INVALID_BACKUP");
      timestamp(input.exportedAt, "Export time");
      const notes = input.notes.map((value) => {
        const original = object(value);
        boundedText(original.id, "Note ID", 100, false);
        const createdAt = timestamp(original.createdAt, "Creation time");
        const updatedAt = timestamp(original.updatedAt, "Update time");
        if (updatedAt < createdAt) fail(400, "A note's update time precedes its creation time.", "INVALID_BACKUP");
        return { ...validateNote(value), id: crypto.randomUUID(), createdAt, updatedAt };
      });
      if (notes.length) await db().batch(notes.map((note) => insertNote(user.userId, note)));
      return json({ ok: true, imported: notes.length });
    }),
  };
}
