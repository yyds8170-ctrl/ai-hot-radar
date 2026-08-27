# AI 热门项目雷达 🛰️

自动抓取 Hacker News 和 GitHub 上的热门 AI 项目，**每天 4 次（每 6 小时）**自动更新 `data.json`，关机也能跑。

## 数据来源

- **Hacker News** — topstories + showstories 中 AI 相关热门帖（30 分以上）
- **GitHub** — 16 组关键词（AI 换装 / 视频 / 图像 / Agent / MCP / 开源模型等）搜索近两个月活跃仓库，按 star 取 top 40

## 自动分类

- AI服装换装
- AI视频生成
- AI图像/电商设计
- AI新模型
- 效率/Agent工具

## 工作原理

- `.github/workflows/crawl.yml` — GitHub Actions 定时任务（每 6 小时 + 手动触发）
- `crawler.mjs` — 零依赖抓取脚本，Node 18+ 即可运行
- `data.json` — 输出数据，包含 32 条人工精选 + 自动抓取结果
- 前端应用直接读取本仓库的 `data.json` 渲染

## 手动触发

去 Actions 页面 → "定时抓取AI热门项目" → Run workflow，可立即抓取一次。

## 本地运行

```bash
GITHUB_TOKEN=你的token node crawler.mjs
```
