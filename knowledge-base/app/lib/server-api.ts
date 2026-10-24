import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../chatgpt-auth";
import { createVaultApi, type VaultDatabase } from "./vault-api";

export const api = createVaultApi({
  getUser: getChatGPTUser,
  getDatabase() {
    if (!env.DB) throw new Error("Database unavailable");
    return env.DB as unknown as VaultDatabase;
  },
});
