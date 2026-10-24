# 拾知 · Alex Notes

一个中文私人知识库，部署于 Sites。外层由 Sites 限制为所有者账号访问，内层由独立知识库密码解锁。

## 首次使用

打开部署地址，完成账号验证，在页面设置自己的 12–128 字符密码。没有默认线上密码。初始三篇中文指南仅用于熟悉操作，可以编辑或移入回收站。

笔记支持 Markdown 编辑和预览、全文关键词搜索、笔记本、标签、收藏和回收站。保存按钮会明确确认保存；检测到其他窗口的修改时返回冲突并保留草稿。离开时可锁定空间。

备份包含所有笔记和回收站内容。JSON 导入新增副本而不覆盖已有笔记；重复导入会产生副本。大文件会按不超过 500 篇、5 MiB 的请求分批导入，每批原子提交，整个多批操作不是单一事务。界面报告已经完成的篇数；部分失败时不要重复导入整个文件。单文件上限 50 MiB。Markdown 单篇正文上限 100,000 个 UTF-16 单位。下载的备份是可读的笔记正文，应妥善保管。

## 开发与验证

需要 Node.js 22.13 或更新版本。

```sh
npm ci
npm run typecheck
npm test
npm run db:generate
npm run build
```

数据库迁移已提交在 `drizzle/`；只有修改 schema 时才需要重新生成。不要编辑已应用的迁移。

本地数据库和线上数据库完全独立。先构建一次生成本地配置，再应用尚未执行的迁移：

```sh
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_misty_star_brand.sql
npm run dev
```

开发服务器默认只在本机 `127.0.0.1:5173` 开放。便携开发环境通过 `/signin-with-chatgpt?return_to=/` 使用 `local_seedy` 模拟身份；生产构建不包含模拟登录。

`npm run test:local` 对已启动的本地预览运行实际 HTTP 检查，仅允许 loopback 地址。它使用独立的开发测试知识库和固定测试口令，不能对真实线上数据运行。不要将本地测试库当作日常笔记库。

## 安全边界

- 每个 API 先检查平台账号，笔记、密码验证记录和会话均按稳定 user ID 隔离。
- 密码保存为随机盐的 PBKDF2-SHA256 摘要，100,000 次迭代，符合 Workers 单次调用上限；原密码不落盘、不进入浏览器包。
- 会话为 256 位随机不透明令牌，数据库仅保存 SHA-256 摘要；8 小时过期。Cookie 使用 HttpOnly、SameSite=Strict，HTTPS 下使用 Secure。
- 每次笔记 CRUD、备份读写都会验证会话。修改密码撤销旧会话；锁定撤销当前会话。
- 密码验证在数据库原子预留尝试次数，10 分钟最多 5 次尝试，成功后清零。
- 写入请求验证同源 Origin；JSON 请求限制字节数，导入先完整验证再原子写入。
- API 响应为 private, no-store；笔记不进入 localStorage 或公共 GitHub 内容目录。
- Markdown 使用 React 节点渲染，原始 HTML 不执行，链接协议受限。

这是服务端访问控制方案，不是端到端加密。服务端数据库持有笔记正文。当前没有忘记密码重置流程，请使用密码管理器保存口令。

## 项目文件

- `app/page.tsx`：知识库界面和编辑流程。
- `app/components/Markdown.tsx`：安全 Markdown 显示与目录。
- `app/chatgpt-auth.ts`：平台身份辅助方法。
- `app/lib/vault-api.ts`：密码、会话、笔记及备份逻辑。
- `app/api/`：动态服务端路由。
- `db/schema.ts`、`drizzle/`：数据表与迁移。
- `.openai/hosting.json`：Site 标识和 DB 绑定，没有密码或令牌。
- `tests/backend.test.mjs`：SQLite 身份隔离、会话、限流、并发和事务检查。
- `tests/e2e-local.mjs`：真实本地 HTTP 流程。

## 发布

使用 Sites 插件的 source/build/package/private-deploy 流程，保持 `.openai/hosting.json` 中的 project_id 和所有者访问策略。普通 GitHub Pages 不能托管该应用的服务端。不要将 `.wrangler/`、`.sites-runtime/`、数据库、备份或密码提交到 Git。
