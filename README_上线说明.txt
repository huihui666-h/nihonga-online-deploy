日本画画家整合：线上网站版

这个版本用于部署成真正的网站：
- 访问者打开网址，可直接以访客身份浏览，也可使用邮箱注册 / 登录。
- 你打开 /admin，用管理员密码进入后台。
- 后台可以添加、删除、修改画家，并审核投稿、修改报告和点击量。
- 数据存在 Supabase，别人刷新网站就能同步更新。

一、你需要注册的账号

1. Vercel
   用来放网站和 API。

2. Supabase
   用来放画家名单、邮箱账户、会话和网站业务数据。

账号、邮箱验证、密码这些需要你自己输入，我可以在旁边一步一步带你点。

二、Supabase 设置

1. 新建一个 Supabase Project。
2. 打开 SQL Editor。
3. 导入现有 artists、artist_submissions 和 artist_clicks 表结构及画家数据。
4. 运行 seed/email-auth.sql，创建 site_users 和 site_sessions 两张认证表。
5. 打开 Project Settings -> API，复制：
   - Project URL
   - service_role key

注意：service_role key 是后台总钥匙，不要发给别人。

三、Vercel 设置

1. 新建 Project，并上传/导入这个文件夹。
2. 在 Environment Variables 里添加：
   - SUPABASE_URL = Supabase 的 Project URL
   - SUPABASE_SERVICE_ROLE_KEY = Supabase 的 service_role key
   - ADMIN_PASSWORD = 你自己设置的后台管理员密码
3. 部署。

四、邮箱注册 / 登录

1. 在 Supabase SQL Editor 执行 `seed/email-auth.sql`。这一步只创建
   `site_users` 和 `site_sessions` 两张认证表，不会修改现有画家数据。
2. 部署包含 `api/auth-register.js`、`api/auth-login.js`、`api/auth-session.js`
   （另有兼容别名 `api/auth-me.js`）和 `api/auth-logout.js` 的版本后，前台即可使用
   邮箱和密码注册、登录、退出。
3. 会话使用 HttpOnly、SameSite=Lax Cookie；数据库只保存 scrypt 密码摘要和
   SHA-256 会话摘要。不要把 `SUPABASE_SERVICE_ROLE_KEY` 放到前端。
4. 当前接口不发送邮箱验证码。若以后需要“验证邮箱 / 忘记密码”，应接入邮件服务
   后再增加一次性 token 表和限时流程，不能把密码或邮件 token 写入日志。
5. “访客浏览”不创建账户，状态只保留在当前浏览器标签会话中；访客退出后回到登录页。

五、怎么使用

访问者：
- 打开 Vercel 给你的网址。
- 可选择“访客浏览”直接进入目录。
- 需要账户时选择“注册”，填写邮箱和密码；之后用邮箱登录即可查看画家目录。

你自己：
- 打开 网址/admin。
- 输入 ADMIN_PASSWORD。
- 可以添加画家、修改学校/地区/标签、删除画家，并管理投稿、修改报告和点击量。

六、Instagram 批量导入（去重）

1. 安装爬虫依赖：
   python -m pip install "scrapling[all]>=0.4.11"
2. 新建 `scripts/instagram-seeds.txt`，每行放一个你有权处理的公开 Instagram 主页 URL 或 @handle。
3. 先生成去重报告（不会写数据库）：
   python scripts/instagram_import.py --seed-file scripts/instagram-seeds.txt --require-nihonga-keyword --out imports/instagram-candidates.json
4. 检查 `imports/instagram-candidates.json` 后，再执行导入：
   python scripts/instagram_import.py --seed-file scripts/instagram-seeds.txt --require-nihonga-keyword --push \
     --admin-password-file "C:\Users\Administrator\Desktop\NIHONNG\线上网站\后台管理员密码_日本画线上版.txt"

爬虫会先读取网站现有名单，按规范化 Instagram 账号、链接和姓名去重；接口也会再次按账号拦截重复项。
Instagram 的 robots.txt 不允许通用自动抓取时，脚本会记录 skipped，不绕过登录或访问限制。

七、邮箱接口与会话

- POST /api/auth-register：email、password、displayName（可选）、remember（可选）
- POST /api/auth-login：email、password、remember（可选）
- GET /api/auth-session（或兼容别名 /api/auth-me）：检查当前登录状态
- POST /api/auth-logout：退出登录

密码使用 Node.js 内置 crypto.scrypt 哈希。默认长期登录为 30 天，可在 Vercel 添加 AUTH_SESSION_DAYS（1-365）修改；未勾选“记住登录”时使用浏览器会话 Cookie，服务端最长保留 1 天。后台管理员密码仍由 ADMIN_PASSWORD 单独控制。

当前实现是“注册后直接登录”。email_verified_at 字段已经预留；若以后要求先验证邮箱，再接入邮件服务并把登录条件改为 email_verified_at 非空。

八、本地文件说明

api/
  云端接口。负责邮箱认证、读取画家和后台管理。

public/
  网站页面。index.html 是目录页，admin.html 是后台页。

seed/
  数据库脚本。email-auth.sql 用来创建邮箱账户和会话表。

scripts/
  Instagram 候选收集、去重、导入和相关测试。
