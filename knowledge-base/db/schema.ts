import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const vaults = sqliteTable("vaults", {
  userId: text("user_id").primaryKey(),
  passwordHash: text("password_hash").notNull(),
  passwordSalt: text("password_salt").notNull(),
  iterations: integer("iterations").notNull(),
  passwordVersion: text("password_version").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const vaultSessions = sqliteTable("vault_sessions", {
  tokenHash: text("token_hash").primaryKey(),
  userId: text("user_id").notNull().references(() => vaults.userId, { onDelete: "cascade" }),
  vaultVersion: text("vault_version").notNull(),
  expiresAt: integer("expires_at").notNull(),
  createdAt: integer("created_at").notNull(),
}, (table) => [index("vault_sessions_user_idx").on(table.userId)]);

// Attempts are reserved atomically before expensive password verification.
export const vaultAttempts = sqliteTable("vault_attempts", {
  userId: text("user_id").primaryKey(),
  windowStart: integer("window_start").notNull(),
  attempts: integer("attempts").notNull(),
});

export const notes = sqliteTable("notes", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => vaults.userId, { onDelete: "cascade" }),
  title: text("title").notNull(),
  content: text("content").notNull(),
  notebook: text("notebook").notNull(),
  tagsJson: text("tags_json").notNull(),
  favorite: integer("favorite", { mode: "boolean" }).notNull(),
  archived: integer("archived", { mode: "boolean" }).notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [index("notes_user_updated_idx").on(table.userId, table.updatedAt)]);
