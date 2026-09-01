# Nihonga Now 新闻流水线

## 导出本地 Artist seed

`export-seed` 只读取本地 Artist JSON 快照，生成可人工检查的 Supabase SQL；它
只写入 `artists` 的公开字段，不读取环境变量，也不会导出管理员密码、会话、许可证、
ID、时间戳或输入中的未知字段。默认输入为 `imports/existing-artists.json`，默认输出为
`seed/supabase-init.sql`：

```powershell
npm run export-seed
```

首次运行会创建默认输出。如果 `seed/supabase-init.sql` 已存在并需要重新生成，
请显式传入 `--force`：

```powershell
npm run export-seed -- --force
```

也可以显式指定快照和输出路径；使用 `-` 将 SQL 输出到标准输出：

```powershell
node scripts/build-seed.js `
  --input imports/existing-artists-live-20260901.json `
  --out seed/supabase-init.sql `
  --force
node scripts/build-seed.js --input imports/existing-artists.json --out -
```

生成的 SQL 包含建表语句并会先清空 `artists`，运行前请保留快照并人工确认。

该命令与 Instagram crawler、Instagram parser 和现有 Artist 写入流程完全独立：

```text
可信来源配置 -> news crawler -> AI processor -> 程序发布规则 -> news/news_artists
```

先只抓取并生成本地候选报告，不写数据库：

```powershell
npm run crawl:news -- --out imports/news-candidates.json
```

启用 AI 处理：

```powershell
$env:OPENAI_API_KEY = "..."
$env:OPENAI_MODEL = "gpt-4o-mini" # 可选
$env:OPENAI_BASE_URL = "https://api.openai.com/v1/chat/completions" # 可选，需为完整 endpoint
npm run crawl:news -- --process-ai --out imports/news-processed.json
```

AI key 缺失时命令仍会成功，候选保存在本地 state，后续配置 key 后可继续处理。写入现有 Supabase 前，先人工执行一次 `seed/nihonga-now-news.sql`，再显式配置并运行：

```powershell
$env:SUPABASE_URL = "..."
$env:SUPABASE_SERVICE_ROLE_KEY = "..."
npm run crawl:news -- --process-ai --write
```

`--write` 只写 `news` 和 `news_artists`，并按东京日期更新已过期记录。抓取节选最多 1,400 字符，仅保存在本地报告/state 供 AI 输入，不写入数据库 `summary`；数据库和前端只使用 AI 生成的原创短摘要。来源配置、字段约束、发布规则和故障处理详见 `news/README.md`。

News 测试：

```powershell
npm run check-news
```

# Instagram 公开资料导入

`instagram_import.py` 用于从**手工提供的公开 Instagram 个人主页**生成日本画家候选名单。它只读取公开页面元数据，不使用登录 Cookie，不读取私信/通讯录。默认只生成审核 JSON；确认后加 `--push` 才会把去重后的新增记录写入网站后台 API。

## 安装

```text
python -m pip install "scrapling[all]>=0.4.11"
scrapling install --force
```

## 准备种子

每次最多处理 50 个账号（可用 `--limit` 调整，上限 200）。可以重复使用 `--seed`，也可以使用 TXT、CSV、JSON 或 Instagram 账户中心导出的 `following.json` / `following.html`：

```text
https://www.instagram.com/example_artist/
@another_artist
```

种子必须是个人主页，不要填帖子、Reel、搜索结果或标签页。脚本会先规范化 handle，并在抓取前检查 Instagram 的 `robots.txt`。

从 Instagram 获取自己的关注列表时，在“账户中心 → 你的信息和权限 → 下载你的信息”中选择关注列表，格式选 JSON 或 HTML。把导出的 `following.json` 或 `following.html` 放到项目目录后，直接把它作为 `--seed-file`。

## 生成审核文件

先保存网站当前画家列表（只读 GET）：

```powershell
Invoke-WebRequest `
  -Uri "https://nihonga-online-deploy.vercel.app/api/artists" `
  -OutFile "existing-artists.json"
```

然后运行：

```powershell
python scripts/instagram_import.py `
  --seed-file seeds.txt `
  --existing-file existing-artists.json `
  --require-nihonga-keyword `
  --out imports/instagram-candidates.json
```

也可以省略 `--existing-file`，脚本会从 `NIHONGA_ARTISTS_API` 或默认的 `/api/artists` 地址执行 GET：

```powershell
python scripts/instagram_import.py `
  --seed "https://www.instagram.com/example_artist/" `
  --out imports/instagram-candidates.json
```

输出 JSON 包含：

- `newArtists`：按网站 `artists` 表字段生成的待审核候选（`name`、`handle`、`instagram`、`styles`、`note` 等）。
- `newArtists[].sources`：规范化后的来源身份（目前包含 Instagram `provider`、`username`、`url`）；这是附加元数据，不会替换网站现有 Artist 公共字段。
- `duplicates`：根据规范化 handle 与现有 `/api/artists` 或同批结果重复的账号。
- `rejected`：无效主页、robots.txt 不允许、缺少日本画关键词等。
- `errors`：单个页面抓取失败，不会中断整批任务；临时网络错误会按指数退避重试。

联系方式（邮箱、电话号码）会从公开简介中移除，粉丝/帖子计数不会写入候选记录。默认 `--delay 2` 秒；请保留低并发、小批量运行。

## 稳定运行选项

抓取和写入默认每项最多尝试 3 次，可按本地网络情况调整：

```powershell
python scripts/instagram_import.py `
  --seed-file seeds.txt `
  --retry-attempts 3 `
  --retry-backoff 1 `
  --log-file imports/instagram-crawler.jsonl `
  --state-file imports/instagram-push-state.json `
  --out imports/instagram-candidates.json
```

`--log-file` 为追加式 JSONL，只记录 URL、handle、状态、尝试次数和错误类型，不写入密码、Cookie、简介正文或响应体。`--state-file` 在 `--push` 时保存每个候选的稳定幂等键；已成功写入或已确认重复的记录在中断后重跑会跳过，错误记录会再次尝试。每次请求都会携带相同的 `Idempotency-Key`，即使超时后重试也不会因为 crawler 本地状态丢失而改变身份。

## 数据库级唯一约束

API 会在写入前检查规范化账号；要让多个 serverless 实例并发写入时也不会产生重复，请在 Supabase SQL Editor 执行 `seed/artist-instagram-identity.sql`。脚本先输出现有重复 handle/URL，确认结果为空后再创建大小写不敏感的唯一索引；历史占位值（例如 `IG 待补`）不会被索引。该迁移不删除或重命名任何 Artist 公共字段。

## 人工审核与添加

打开网站后台的“画家管理”，逐条核对姓名、学校、地区、画风和主页是否确实属于日本画家，再复制 `newArtists` 中的字段保存。

确认整批候选后，可以让脚本通过管理员 API 批量写入。接口会再次按 Instagram 账号去重：

```powershell
python scripts/instagram_import.py `
  --seed-file seeds.txt `
  --require-nihonga-keyword `
  --push `
  --admin-password-file "C:\Users\Administrator\Desktop\NIHONNG\线上网站\后台管理员密码_日本画线上版.txt" `
  --out imports/instagram-pushed.json
```

`--push` 只发送本次 `newArtists`，不会删除或覆盖现有画家；服务器返回重复项时会记录到 `duplicates`。

## 仅用本地文件审核关注列表

Instagram 关注列表通常只有账号和显示名，不能据此确认一个账号是否属于日本画家。`instagram_following_report.py` 会把本地关注列表、网站画家快照和此前保存的公开简介合并，生成分级报告。关注列表支持 JSON、HTML、CSV 或每行一个主页 URL 的 TXT。脚本不访问 Instagram，也不调用网站接口：

```powershell
python scripts/instagram_following_report.py `
  --following-file imports/instagram-following-browser.json `
  --existing-file imports/existing-artists.json `
  --metadata-file imports/instagram-browser-candidates.json `
  --out imports/instagram-following-audit.json
```

如果已有浏览器保存的简介快照，可改用 `--metadata-file imports/instagram-profile-scan.json`；该快照仍只作为本地审核输入，不会触发重新抓取。

报告分为 `highConfidence`、`review`、`excluded`、`missingMetadata` 和 `unclassified`。其中 `missingMetadata` 只表示本地文件没有足够的公开简介，不应自动加入网站。学校、研究室、画廊、材料商、展览和备考账号会单独分桶，避免和画家个人账号混在一起。

现有导入器没有 Instagram 全站发现入口；它只能审核用户提供的账号种子。Instagram `robots.txt` 不允许抓取时，导入器会保留 `robots-denied` 并跳过，不使用登录 Cookie 或私有接口绕过。

## 已审核名单批量写入

对已经在本地浏览器快照中完成审核的账号，可使用 `instagram_reviewed_push.py` 直接映射成统一 Artist 字段。它复用 Instagram handle 幂等键、管理员 API 去重、追加式 JSONL 日志和可恢复 state；重复运行只会跳过已成功或已判定重复的记录：

```powershell
python scripts/instagram_reviewed_push.py `
  --audit-file imports/instagram-following-audit-final-20260901.json `
  --approved-file imports/instagram-reviewed-following-handles-20260901.txt `
  --out imports/instagram-reviewed-push.json `
  --push `
  --admin-password-file "C:\Users\Administrator\Desktop\NIHONNG\线上网站\后台管理员密码_日本画线上版.txt" `
  --state-file imports/instagram-reviewed-push-state.json `
  --log-file imports/instagram-reviewed-push.jsonl
```

审核名单只应放入个人画家账号；学校、研究室、画廊、材料商、展览、备考和未成年账号留在审核报告中，不加入 `--approved-file`。

## 学校公开页面来源

`school_crawler.py` 用于读取学校官网的日本画课程、学生作品展、毕业制作展和教员名单页面。学校页面是 `university` 来源，学生姓名、年级、教员职务会进入统一 Artist 结构，并生成稳定的 `schoolSourceId`；教员记录带有 `personType: faculty` 和 `facultyRole`。没有匹配到个人主页时，`handle` 保持为空，不写入假账号；这类记录只进入审核报告，待人工补充公开个人主页后再进入写入器。

文星艺术大学示例：

```powershell
npm run crawl:schools -- `
  --source-file imports/school-sources-bunsei-20260902.json `
  --existing-file imports/existing-artists-live-after-reviewed-extended-20260901.json `
  --out imports/school-bunsei-candidates-20260902.json `
  --log-file imports/school-bunsei-crawler-20260902.jsonl
```

`--profile-map-file` 可选，用 JSON 对象把官网公开姓名映射到已经核实的 Instagram 或个人主页；教师也可以只映射到学校官方教师介绍页。学校来源不会读取登录态、私信或通讯录，且每个 URL 会先检查 `robots.txt` 并按指数退避重试。带有学校官方来源页但没有 Instagram 的教员记录，也可以通过 `--push --only-faculty` 入库；后续补充个人主页时再从后台 PATCH 更新。

## 本地测试

```text
node scripts/test_build_seed.cjs
python -m unittest discover -s scripts -p "test_instagram*.py" -v
python -m py_compile scripts/instagram_import.py scripts/instagram_following_report.py scripts/test_instagram_import.py scripts/test_instagram_following_report.py
```
