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
- `duplicates`：根据规范化 handle 与现有 `/api/artists` 或同批结果重复的账号。
- `rejected`：无效主页、robots.txt 不允许、缺少日本画关键词等。
- `errors`：单个页面抓取失败，不会中断整批任务。

联系方式（邮箱、电话号码）会从公开简介中移除，粉丝/帖子计数不会写入候选记录。默认 `--delay 2` 秒；请保留低并发、小批量运行。

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

## 本地测试

```text
python -m unittest discover -s scripts -p "test_instagram*.py" -v
python -m py_compile scripts/instagram_import.py scripts/instagram_following_report.py scripts/test_instagram_import.py scripts/test_instagram_following_report.py
```
