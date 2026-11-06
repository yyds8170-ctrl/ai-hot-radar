// AI 热门项目雷达 - 自动抓取脚本
// 数据源：Hacker News + GitHub Search API + Hugging Face 模型/Spaces + 中文AI媒体 + Reddit r/LocalLLaMA + arXiv
// 零依赖，Node 18+ 内置 fetch
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = join(__dirname, 'data.json');
// GitHub Pages 从仓库 /docs 目录部署，feed.xml 必须写到 docs/ 下才能被访问
const FEED_PATH = join(__dirname, 'docs', 'feed.xml');
const SITE_URL = 'https://yyds8170-ctrl.github.io/ai-hot-radar/';

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const UA = 'ai-hot-radar/1.0 (+https://github.com/yyds8170-ctrl/ai-hot-radar)';
// 浏览器 UA，用于需要伪装浏览器的源（Reddit、RSS 等）
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

// ---------- 分类规则 ----------
// 说明：classify() 改为评分制——一条文本命中某分类多个关键词时给该分类加权，
// 取最高分分类；并列时按 CATEGORIES 数组顺序优先。
// 兜底分类为 'ai-other'（前端 CATS 没有这个键时，请在前端把它映射到 ai-tool 渲染，避免白屏）。
const CATEGORIES = [
  {
    key: 'ai-clothing',
    name: 'AI服装换装',
    keywords: ['virtual-try-on', 'virtual try-on', 'vton', 'try-on', 'tryon', 'fashion-ai', 'fashion ai', 'fashion model', 'human pose', 'garment transfer', 'garment', 'wardrobe', 'outfit', 'clothing', 'clothes', 'dress', 'shirt', 'pants', 'jacket', '换装', '试穿', '试衣', '穿搭', '模特'],
  },
  {
    key: 'ai-video',
    name: 'AI视频生成',
    keywords: ['text-to-video', 'image-to-video', 'video generation', 'video-generator', 'video model', 'video editing', 'lip-sync', 'lipsync', 'talking head', 'animate', 'animation', 'motion transfer', 'veo', 'kling', 'seedance', 'runway gen', 'runwayml', 'sora', 'hailuo', 'minimax video', 'wan2', 'video diffusion', 'text to video', '视频生成', '数字人', '口型', 'ai video'],
  },
  {
    key: 'ai-image',
    name: 'AI图像/电商设计',
    keywords: ['text-to-image', 'image-generation', 'image generation', 'image-editing', 'image editing', 'background removal', 'product photography', 'product photo', 'inpainting', 'outpainting', 'upscaler', 'upscale', 'nano banana', 'seedream', 'comfyui', 'stable-diffusion', 'stable diffusion', 'flux', 'midjourney', 'photoshop plugin', 'ecommerce image', 'diffusion model', '文生图', '作图', '修图', '抠图', '白底图', '商品图'],
  },
  {
    key: 'ai-model',
    name: 'AI新模型',
    keywords: ['open-weight', 'open weight', 'open-source llm', 'open-weights', 'llm release', 'new model', 'foundation model', 'gpt-', 'claude-', 'gemini-', 'qwen', 'deepseek', 'llama', 'mistral', 'grok', 'kimi', 'model release', 'large language model', '大模型', '开源模型'],
  },
  {
    key: 'ai-tool',
    name: '效率/Agent工具',
    keywords: ['ai-agent', 'ai agent', 'agentic', 'mcp', 'model context protocol', 'coding agent', 'copilot', 'cursor', 'claude code', 'codex', 'workflow automation', 'productivity ai', 'llm tool', 'rag framework', 'agent framework', '智能体'],
  },
];

// 必须命中的 AI 大词（HN/Reddit 标题过滤用，避免无关内容）
const AI_HINT = /\b(ai|llm|gpt|agent|agents|agentic|mcp|model|models|diffusion|transformer|neural|machine learning|deep learning|genai|generative|chatbot|copilot|claude|gemini|openai|anthropic|deepseek|qwen|comfyui|veo|kling|sora|runway|vton|try-on|inference|embedding|rag|lora|gguf|quantiz|finetun|fine-tun|vision|multimodal|vlm|tts|stt|asr)\b|人工智能|大模型|机器学习|深度学习|生成式|智能体|多模态|算力|大语言模型|开源模型/i;

// 评分分类：统计每个分类命中的关键词数，取最高分；0 分兜底到 ai-other
function classify(text) {
  const t = (text || '').toLowerCase();
  let bestKey = 'ai-other';
  let bestScore = 0;
  for (const cat of CATEGORIES) {
    let score = 0;
    for (const kw of cat.keywords) {
      if (t.includes(kw.toLowerCase())) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestKey = cat.key;
    }
  }
  return bestKey;
}

const now = new Date().toISOString();
const today = now.slice(0, 10);

// ---------- 链接规范化：用于跨源去重（GitHub 大小写差异、RSS 重复收录、带追踪参数等） ----------
// 规则：host 转小写、pathname 去掉末尾 '/'、剔除 utm_* / ref / fbclid / gclid 等追踪参数
function normalizeLink(u) {
  if (!u) return '';
  try {
    const x = new URL(u);
    x.host = x.host.toLowerCase();
    x.protocol = x.protocol.toLowerCase();
    // 去掉默认端口
    if ((x.protocol === 'http:' && x.port === '80') || (x.protocol === 'https:' && x.port === '443')) {
      x.port = '';
    }
    if (x.pathname.length > 1 && x.pathname.endsWith('/')) x.pathname = x.pathname.slice(0, -1);
    for (const k of [...x.searchParams.keys()]) {
      if (/^(utm_|ref$|fbclid$|gclid$|spm$|from$)/i.test(k)) x.searchParams.delete(k);
    }
    // 按 key 排序参数，避免 ?a=1&b=2 与 ?b=2&a=1 被视为不同链接
    const sorted = [...x.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
    x.search = sorted.length ? '?' + sorted.map(([k, v]) => `${k}=${v}`).join('&') : '';
    return x.origin + x.pathname + x.search;
  } catch {
    return String(u).trim().toLowerCase();
  }
}

// ---------- 垃圾摘要清洗：所有源入库前统一走这一步 ----------
// 黑名单值 / 纯单词且等于 name / 长度 < 3 的 summary 一律用 fallback 兜底
// selfName：当前条目的 name，若 raw 去掉标点后与 name 相同，视为"摘要就是标题本身"，无信息量
const SUMMARY_BLACKLIST = new Set(['other', 'translation', 'unknown', 'n/a', 'na', 'null', 'none', '-', '--', 'n\/a']);
function cleanSummary(raw, fallback, selfName) {
  const s = (raw || '').trim();
  const f = (fallback || '').trim();
  if (!s) return f;
  if (SUMMARY_BLACKLIST.has(s.toLowerCase())) return f;
  if (s.length < 3) return f;
  // 摘要本身就是标题（常见于 HF API 把 model id 当 short_description 返回），无信息量
  if (selfName) {
    const norm = (x) => String(x).replace(/[\s_\-.:/]+/g, '').toLowerCase();
    if (norm(s) === norm(selfName) && s.split(/\s+/).length <= 3) return f;
  }
  return s;
}

// ---------- XML 转义：RSS feed 用 ----------
function escapeXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ISO Date → RFC 822（RSS pubDate 要求）
function toRfc822(d) {
  const date = d instanceof Date ? d : new Date(d);
  if (isNaN(date.getTime())) return '';
  // Fri, 06 Nov 2026 10:00:00 GMT
  return date.toUTCString();
}

// ---------- 生成 RSS 2.0 feed ----------
// 取 auto + curated 合并后按日期倒序前 50 条；description 优先 summary_zh，其次 summary
function buildRssFeed(allItems) {
  const sorted = [...allItems].sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))).slice(0, 50);
  const itemsXml = sorted.map((it) => {
    const title = escapeXml(it.name || it.id || '');
    const link = escapeXml(it.link || SITE_URL);
    const guid = escapeXml(it.id || it.link || it.name || '');
    const pubDate = it.date ? toRfc822(it.date) : '';
    const descRaw = it.summary_zh || it.summary || it.description || it.name || '';
    const desc = escapeXml(descRaw);
    return [
      '    <item>',
      `      <title>${title}</title>`,
      `      <link>${link}</link>`,
      `      <guid isPermaLink="false">${guid}</guid>`,
      pubDate ? `      <pubDate>${pubDate}</pubDate>` : '',
      `      <description>${desc}</description>`,
      `      <category>${escapeXml(it.category || '')}</category>`,
      `      <author>${escapeXml(it.source || '')}</author>`,
      '    </item>',
    ].filter(Boolean).join('\n');
  }).join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0">',
    '  <channel>',
    `    <title>${escapeXml('AI 热门项目雷达')}</title>`,
    `    <link>${escapeXml(SITE_URL)}</link>`,
    `    <description>${escapeXml('洋洋制作的 AI 项目自动追踪订阅源，每 6 小时自动抓取 Hacker News / GitHub / Hugging Face / arXiv / 中文 AI 媒体 / Reddit 热帖，第一时间发现新模型、新工具、新论文。')}</description>`,
    '    <language>zh-cn</language>',
    `    <lastBuildDate>${toRfc822(new Date())}</lastBuildDate>`,
    '    <generator>ai-hot-radar crawler.mjs</generator>',
    itemsXml,
    '  </channel>',
    '</rss>',
    '',
  ].join('\n');
}

// ---------- 读取已有数据（保留精选） ----------
let data = { version: 1, lastCrawl: null, curated: [], auto: [] };
if (existsSync(DATA_PATH)) {
  try {
    data = JSON.parse(readFileSync(DATA_PATH, 'utf8'));
  } catch {}
}
const curated = Array.isArray(data.curated) ? data.curated : [];

async function fetchJson(url, opts = {}) {
  const headers = { 'User-Agent': UA, ...(opts.headers || {}) };
  const res = await fetch(url, { ...opts, headers });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

// ---------- Hacker News ----------
async function crawlHN() {
  const items = [];
  try {
    const [top, show] = await Promise.all([
      fetchJson('https://hacker-news.firebaseio.com/v0/topstories.json'),
      fetchJson('https://hacker-news.firebaseio.com/v0/showstories.json'),
    ]);
    const ids = [...top.slice(0, 100), ...show.slice(0, 50)];
    const uniqueIds = [...new Set(ids)];
    // 分批拉取详情
    const batchSize = 20;
    for (let i = 0; i < uniqueIds.length; i += batchSize) {
      const batch = uniqueIds.slice(i, i + batchSize);
      const details = await Promise.all(
        batch.map((id) =>
          fetchJson(`https://hacker-news.firebaseio.com/v0/item/${id}.json`).catch(() => null)
        )
      );
      for (const d of details) {
        if (!d || d.dead || d.deleted || d.type !== 'story') continue;
        if (!d.title || !AI_HINT.test(d.title)) continue;
        if ((d.score || 0) < 30) continue;
        const link = d.url || `https://news.ycombinator.com/item?id=${d.id}`;
        items.push({
          id: `hn-${d.id}`,
          name: d.title,
          category: classify(d.title),
          tags: ['Hacker News'],
          summary: d.title,
          description: `HN 热度 ${d.score} 分 · ${d.descendants || 0} 条评论`,
          usage: '',
          link,
          source: 'Hacker News',
          hotness: Math.min(5, Math.max(1, Math.round((d.score || 0) / 100))),
          date: new Date((d.time || Date.now() / 1000) * 1000).toISOString().slice(0, 10),
          sourceType: 'auto',
        });
      }
    }
    console.log(`[HN] 抓取 ${items.length} 条 AI 相关`);
  } catch (e) {
    console.error('[HN] 抓取失败:', e.message);
  }
  return items;
}

// ---------- GitHub（含深度 topic 搜索） ----------
async function crawlGitHub() {
  const items = [];
  const seen = new Set();
  // 原有关键词 + 新增电商设计/换装/视频方向深度 query
  const keywords = [
    'virtual-try-on', 'vton', 'fashion-ai',
    'text-to-video', 'ai-video-generation', 'video-generation',
    'text-to-image', 'image-generation', 'comfyui',
    'ai-agent', 'llm-agent', 'agent-framework',
    'mcp-server', 'model-context-protocol',
    'open-source-llm', 'local-llm',
  ];
  // 新增：针对性深度搜索（name/description/readme 全字段匹配，按 star 阈值过滤）
  const deepQueries = [
    'virtual-try-on in:name,description,readme stars:>100',
    'topic:virtual-try-on',
    'fashion+ai stars:>200',
    'text-to-video stars:>500',
    'topic:text-to-video',
    'image-editing stars:>300',
    'diffusion-model stars:>200',
    'comfyui-workflow stars:>50',
  ];
  try {
    const twoMonthsAgo = new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const headers = { Accept: 'application/vnd.github+json' };
    if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
    let remaining = null;

    // 第一轮：原有关键词（按最近推送时间过滤）
    for (const kw of keywords) {
      const q = `${kw} pushed:>${twoMonthsAgo}`;
      const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=20`;
      try {
        const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers } });
        remaining = res.headers.get('x-ratelimit-remaining');
        if (!res.ok) {
          console.error(`[GitHub] ${kw} -> ${res.status}`);
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
        const json = await res.json();
        for (const repo of json.items || []) {
          if (seen.has(repo.full_name)) continue;
          seen.add(repo.full_name);
          const text = `${repo.name} ${repo.description || ''} ${(repo.topics || []).join(' ')}`;
          const fallback = `${repo.language || 'repo'} · ${(repo.topics || []).slice(0,3).join('/') || '无标签'}`.slice(0, 60);
          const summary = cleanSummary(repo.description, fallback, repo.full_name);
          items.push({
            id: `gh-${repo.full_name}`,
            name: repo.full_name,
            category: classify(text),
            tags: ['GitHub', repo.language].filter(Boolean).concat(repo.topics || []).slice(0, 6),
            summary,
            description: `⭐ ${repo.stargazers_count} stars · ${repo.language || '未知语言'} · ${(repo.topics || []).slice(0, 4).join(', ') || '无标签'}`,
            usage: '',
            link: repo.html_url,
            source: 'GitHub',
            hotness: Math.min(5, Math.max(1, Math.round(Math.log10((repo.stargazers_count || 1) + 1) * 1.2))),
            date: (repo.pushed_at || '').slice(0, 10) || today,
            sourceType: 'auto',
          });
        }
      } catch (e) {
        console.error(`[GitHub] ${kw} 失败:`, e.message);
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    // 第二轮：深度 topic 搜索（不限制推送时间，按 star 阈值找经典/高价值项目）
    for (const dq of deepQueries) {
      const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(dq)}&sort=stars&order=desc&per_page=10`;
      try {
        const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers } });
        remaining = res.headers.get('x-ratelimit-remaining');
        if (!res.ok) {
          console.error(`[GitHub深度] ${dq} -> ${res.status}`);
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
        const json = await res.json();
        for (const repo of json.items || []) {
          if (seen.has(repo.full_name)) continue;
          seen.add(repo.full_name);
          const text = `${repo.name} ${repo.description || ''} ${(repo.topics || []).join(' ')}`;
          const fallback = `${repo.language || 'repo'} · ${(repo.topics || []).slice(0,3).join('/') || '无标签'}`.slice(0, 60);
          const summary = cleanSummary(repo.description, fallback, repo.full_name);
          items.push({
            id: `gh-${repo.full_name}`,
            name: repo.full_name,
            category: classify(text),
            tags: ['GitHub', repo.language].filter(Boolean).concat(repo.topics || []).slice(0, 6),
            summary,
            description: `⭐ ${repo.stargazers_count} stars · ${repo.language || '未知语言'} · ${(repo.topics || []).slice(0, 4).join(', ') || '无标签'}`,
            usage: '',
            link: repo.html_url,
            source: 'GitHub',
            hotness: Math.min(5, Math.max(1, Math.round(Math.log10((repo.stargazers_count || 1) + 1) * 1.2))),
            date: (repo.pushed_at || '').slice(0, 10) || today,
            sourceType: 'auto',
          });
        }
      } catch (e) {
        console.error(`[GitHub深度] ${dq} 失败:`, e.message);
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    // 按 star 排序取 top 50（深度搜索后条目增多，放宽到 50）
    items.sort((a, b) => {
      const sa = parseInt((a.description.match(/⭐ ([\d,]+)/) || [])[1]?.replace(/,/g, '') || '0', 10);
      const sb = parseInt((b.description.match(/⭐ ([\d,]+)/) || [])[1]?.replace(/,/g, '') || '0', 10);
      return sb - sa;
    });
    console.log(`[GitHub] 抓取 ${items.length} 个仓库（去重后），取 top 50；剩余限额 ${remaining}`);
    return items.slice(0, 50);
  } catch (e) {
    console.error('[GitHub] 抓取失败:', e.message);
    return items;
  }
}

// ---------- Hugging Face 热门模型 ----------
async function crawlHuggingFace() {
  const items = [];
  try {
    const url = 'https://huggingface.co/api/models?sort=trendingScore&direction=-1&limit=60';
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`${res.status} for ${url}`);
    const models = await res.json();
    for (const m of models || []) {
      if (!m || !m.id) continue;
      const tags = (m.tags || []).join(' ');
      const text = `${m.id} ${m.pipeline_tag || ''} ${tags}`;
      const link = `https://huggingface.co/${m.id}`;
      const downloads = m.downloads || 0;
      // 垃圾摘要清洗：黑名单/纯单词/过短/等于 model id 一律用 pipeline_tag → 下载量描述兜底
      const rawSum = m.cardData?.short_description || m.pipeline_tag || '';
      const fallback = `${m.pipeline_tag || 'HF 热门模型'} · 下载 ${downloads.toLocaleString()}`.slice(0, 60);
      const summary = cleanSummary(rawSum, fallback, m.id);
      items.push({
        id: `hf-${m.id}`,
        name: m.id,
        category: classify(text),
        tags: ['Hugging Face', m.pipeline_tag].filter(Boolean).concat((m.tags || []).slice(0, 4)).slice(0, 6),
        summary,
        description: `⬇ ${downloads.toLocaleString()} 下载 · ❤ ${(m.likes || 0).toLocaleString()} 点赞 · ${m.pipeline_tag || '多模态'}`,
        usage: '',
        link,
        source: 'Hugging Face',
        hotness: Math.min(5, Math.max(1, Math.round(Math.log10(downloads + 1) * 0.8))),
        date: (m.lastModified || '').slice(0, 10) || today,
        sourceType: 'auto',
      });
    }
    console.log(`[HF模型] 抓取 ${items.length} 个热门模型`);
  } catch (e) {
    console.error('[HF模型] 抓取失败:', e.message);
  }
  return items;
}

// ---------- Hugging Face Spaces 热门应用 ----------
async function crawlHfSpaces() {
  const items = [];
  try {
    // 按近7天点赞排序，取前30个热门 Space
    const url = 'https://huggingface.co/api/spaces?sort=likes7d&direction=-1&limit=30';
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`${res.status} for ${url}`);
    const spaces = await res.json();
    for (const s of spaces || []) {
      if (!s || !s.id) continue;
      const tags = (s.tags || []).join(' ');
      const text = `${s.id} ${s.pipeline_tag || ''} ${tags}`;
      // 过滤掉明显非 AI 工具的 Space（如纯个人主页、数据集等）
      if (!AI_HINT.test(text) && !AI_HINT.test(s.id)) continue;
      const link = `https://huggingface.co/spaces/${s.id}`;
      const likes = s.likes || 0;
      const selfName = s.id.split('/').pop();
      // 垃圾摘要清洗
      const rawSum = s.cardData?.short_description || s.pipeline_tag || '';
      const fallback = `${s.pipeline_tag || 'HF 在线 Demo'} · ❤ ${likes.toLocaleString()}`.slice(0, 60);
      const summary = cleanSummary(rawSum, fallback, selfName);
      items.push({
        id: `hf-space-${s.id}`,
        name: selfName,
        category: classify(text),
        tags: ['HF Spaces', s.pipeline_tag].filter(Boolean).concat((s.tags || []).slice(0, 4)).slice(0, 6),
        summary,
        description: `❤ ${likes.toLocaleString()} 点赞 · ${s.pipeline_tag || '在线Demo'} · 近7天热门`,
        usage: '',
        link,
        source: 'Hugging Face Spaces',
        hotness: Math.min(5, Math.max(1, Math.round(Math.log10(likes + 1) * 1.5))),
        date: (s.lastModified || '').slice(0, 10) || today,
        sourceType: 'auto',
      });
    }
    console.log(`[HF Spaces] 抓取 ${items.length} 个热门应用`);
  } catch (e) {
    console.error('[HF Spaces] 抓取失败:', e.message);
  }
  return items;
}

// ---------- 中文 AI 媒体（新智元 / 量子位 / 机器之心，机器之心带 RSSHub 备用） ----------
async function fetchRssXml(url, timeoutMs = 60000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': BROWSER_UA, Accept: 'application/rss+xml, application/xml, text/xml, */*' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function parseRssItems(xml, maxItems = 15) {
  const out = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) !== null && out.length < maxItems) {
    const block = m[1];
    const get = (tag) => {
      const hit = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
      return hit ? hit[1] : '';
    };
    const title = get('title').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, '$1').replace(/<[^>]*>/g, '').trim();
    const link = get('link').trim();
    const pubDate = get('pubDate').trim();
    const desc = get('description').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, '$1').replace(/<[^>]*>/g, '').replace(/&[a-zA-Z#0-9]+;/g, ' ').trim().slice(0, 180);
    out.push({ title, link, pubDate, desc });
  }
  return out;
}

async function crawlCNMedia() {
  const items = [];
  // 每个源：主 URL 列表，按顺序尝试；机器之心主 URL 已死，自动切 RSSHub 公共实例
  const sources = [
    { name: '新智元', urls: ['https://www.aiera.com.cn/feed'] },
    { name: '量子位', urls: ['https://www.qbitai.com/feed'] },
    // 机器之心：原 /rss 已 302 跳 SPA（无 XML）；先试原站现状，失败切 RSSHub 公共实例（免费无 key）
    {
      name: '机器之心',
      urls: [
        'https://www.jiqizhixin.com/rss',
        'https://rsshub.app/jiqizhixin/news',
      ],
    },
  ];
  for (const src of sources) {
    let parsed = [];
    let usedUrl = '';
    for (const u of src.urls) {
      try {
        const xml = await fetchRssXml(u, u.includes('rsshub.app') ? 60000 : 15000);
        parsed = parseRssItems(xml, 15);
        if (parsed.length) {
          usedUrl = u;
          break;
        }
      } catch (e) {
        console.error(`[${src.name}] ${u} 失败:`, e.message);
      }
    }
    if (!parsed.length) {
      // 机器之心两个端点都挂了：站点改版，待恢复；保留原代码路径，不硬编死链
      if (src.name === '机器之心') {
        console.log(`[${src.name}] RSS 不可用（站点改版，待恢复），本轮跳过`);
      }
      continue;
    }
    let count = 0;
    for (const it of parsed) {
      if (!it.title || !it.link) continue;
      if (!AI_HINT.test(it.title)) continue;
      items.push({
        id: `cn-${createHash('sha1').update(it.link).digest('hex').slice(0, 16)}`,
        name: it.title.slice(0, 80),
        category: classify(it.title),
        tags: [src.name, '中文AI'],
        summary: cleanSummary(it.title, it.title.slice(0, 100), it.title),
        description: it.desc || it.title.slice(0, 80),
        usage: '',
        link: it.link,
        source: src.name,
        hotness: 3,
        date: it.pubDate ? new Date(it.pubDate).toISOString().slice(0, 10) : today,
        sourceType: 'auto',
      });
      count++;
    }
    console.log(`[${src.name}] 抓取 ${count} 条（via ${usedUrl}）`);
  }
  return items;
}

// ---------- Reddit r/LocalLLaMA 热帖（双端点兜底：old.reddit.com → www.reddit.com top） ----------
async function crawlReddit() {
  const items = [];
  // 依次尝试的两个端点：old.reddit.com 在 Actions 环境下更不易被 403；
  // 若 old 挂了再试 www.reddit.com 的 top.json?t=day（比 hot.json 风控略松）
  const endpoints = [
    { name: 'old.reddit.com/hot', url: 'https://old.reddit.com/r/LocalLLaMA/hot.json?limit=30' },
    { name: 'www.reddit.com/top_day', url: 'https://www.reddit.com/r/LocalLLaMA/top.json?t=day&limit=30' },
  ];
  const statusLog = [];
  let posts = null;
  for (const ep of endpoints) {
    try {
      const res = await fetch(ep.url, {
        headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' },
      });
      statusLog.push(`${ep.name}=${res.status}`);
      if (!res.ok) {
        console.error(`[Reddit] ${ep.name} 失败: HTTP ${res.status}`);
        continue;
      }
      const json = await res.json();
      posts = json?.data?.children || [];
      if (posts.length) {
        console.log(`[Reddit] 使用 ${ep.name} 成功，拿到 ${posts.length} 条`);
        break;
      }
    } catch (e) {
      statusLog.push(`${ep.name}=ERR:${e.message}`);
      console.error(`[Reddit] ${ep.name} 异常:`, e.message);
    }
  }
  console.log(`[Reddit] 端点探测: ${statusLog.join(' | ') || '无请求'}`);
  if (!posts) return items;
  try {
    for (const p of posts) {
      const d = p.data;
      if (!d || !d.title) continue;
      // 过滤置顶帖、NSFW、已删除帖
      if (d.stickied || d.over_18 || d.removed_by_category) continue;
      // 按 AI_HINT 过滤（LocalLLaMA 本身就是 AI 板块，但仍过滤水帖）
      if (!AI_HINT.test(d.title) && !AI_HINT.test(d.selftext || '')) continue;
      const link = d.url || `https://www.reddit.com${d.permalink}`;
      const selfText = (d.selftext || '').replace(/\n+/g, ' ').slice(0, 150);
      items.push({
        id: `reddit-llm-${d.id}`,
        name: d.title.slice(0, 100),
        category: classify(`${d.title} ${d.selftext || ''}`),
        tags: ['Reddit', 'r/LocalLLaMA'],
        summary: cleanSummary(d.title, d.title.slice(0, 120), d.title),
        description: `👍 ${d.ups || 0} 赞 · 💬 ${d.num_comments || 0} 评论${selfText ? ' · ' + selfText : ''}`,
        usage: '',
        link,
        source: 'Reddit r/LocalLLaMA',
        hotness: Math.min(5, Math.max(1, Math.round(Math.log10((d.ups || 1) + 1) * 1.5))),
        date: new Date((d.created_utc || Date.now() / 1000) * 1000).toISOString().slice(0, 10),
        sourceType: 'auto',
      });
    }
    console.log(`[Reddit] 抓取 ${items.length} 条 LocalLLaMA 热帖`);
  } catch (e) {
    console.error('[Reddit] 解析失败:', e.message);
  }
  return items;
}

// ---------- arXiv 最新论文（cs.CV 方向） ----------
async function crawlArxiv() {
  const items = [];
  try {
    // 按提交时间倒序，取 cs.CV 最新 20 篇
    const url = 'http://export.arxiv.org/api/query?search_query=cat:cs.CV&sortBy=submittedDate&sortOrder=descending&max_results=20';
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`${res.status} for ${url}`);
    const xml = await res.text();
    // 正则解析 Atom XML：每条 <entry>...</entry>
    const re = /<entry>([\s\S]*?)<\/entry>/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
      const block = m[1];
      const get = (tag) => {
        const hit = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
        return hit ? hit[1].trim() : '';
      };
      // arXiv ID：从 <id>http://arxiv.org/abs/xxxx.xxxxx</id> 提取
      const idRaw = get('id');
      const idMatch = idRaw.match(/abs\/([\w.\-]+)/);
      const arxivId = idMatch ? idMatch[1] : createHash('sha1').update(idRaw).digest('hex').slice(0, 12);
      let title = get('title').replace(/\s+/g, ' ').trim();
      let summary = get('summary').replace(/\s+/g, ' ').trim();
      const published = get('published').slice(0, 10);
      // 提取作者（最多3个）
      const authorRe = /<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g;
      const authors = [];
      let am;
      while ((am = authorRe.exec(block)) !== null && authors.length < 3) {
        authors.push(am[1].trim());
      }
      if (!title || !idRaw) continue;
      // 过滤非 AI 相关论文（cs.CV 里也有纯图形学、传统视觉等）
      if (!AI_HINT.test(title) && !AI_HINT.test(summary.slice(0, 300))) continue;
      const link = `https://arxiv.org/abs/${arxivId}`;
      items.push({
        id: `arxiv-${arxivId}`,
        name: title.slice(0, 100),
        category: classify(`${title} ${summary.slice(0, 300)}`),
        tags: ['arXiv', 'cs.CV'].concat(authors.slice(0, 2)),
        summary: title.slice(0, 150),
        description: `${summary.slice(0, 180)}${authors.length ? ' · 作者: ' + authors.join(', ') : ''}`,
        usage: '',
        link,
        source: 'arXiv',
        hotness: 2, // 论文热度初始偏低，后续可按引用数调整
        date: published || today,
        sourceType: 'auto',
      });
    }
    console.log(`[arXiv] 抓取 ${items.length} 篇 cs.CV 最新论文`);
  } catch (e) {
    console.error('[arXiv] 抓取失败:', e.message);
  }
  return items;
}

// ---------- 免费翻译（Google 主源 + MyMemory 备用，全降级保护，失败不影响主流程）----------
// 每次运行最多翻译条数：目标 4 轮（24h）内消化完历史积压，且不再产生新积压
const MAX_TRANSLATE_PER_RUN = 100;
// 连续失败/限流次数达到该值即提前结束本轮翻译
const MAX_CONSECUTIVE_FAIL = 5;

function hasChinese(s) {
  return /[\u4e00-\u9fff]/.test(s || '');
}

// 单次翻译：返回 { ok, text, reason, source }
// reason: 'empty' | 'rate_limit' | 'quota' | 'fail'
// googleDisabled=true 时跳过 Google 直接走 MyMemory
async function translateOnce(text, googleDisabled) {
  if (!text || !text.trim() || hasChinese(text)) return { ok: false, reason: 'empty' };
  const clean = text.trim().slice(0, 500);
  // 主源：Google Translate 免费接口
  if (!googleDisabled) {
    try {
      const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=${encodeURIComponent(clean)}`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA } });
      clearTimeout(timer);
      if (res.ok) {
        const data = await res.json();
        const translated = (data[0] || []).map(seg => seg[0] || '').join('').trim();
        if (translated && translated.length > 2 && translated !== clean) {
          return { ok: true, text: translated, source: 'google' };
        }
        return { ok: false, reason: 'fail' };
      }
      if (res.status === 429 || res.status === 503) {
        return { ok: false, reason: 'rate_limit', source: 'google' };
      }
      return { ok: false, reason: 'fail' };
    } catch (e) {
      return { ok: false, reason: 'fail' };
    }
  }
  // 备用源：MyMemory 免费 API
  try {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(clean)}&langpair=en|zh-CN`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA } });
    clearTimeout(timer);
    if (res.ok) {
      const data = await res.json();
      // MyMemory 匿名有每日额度，quotaFinished=true 时表示额度已耗尽
      if (data?.responseStatus === '429' || data?.quotaFinished === true) {
        return { ok: false, reason: 'quota', source: 'mymemory' };
      }
      const translated = (data?.responseData?.translatedText || '').trim();
      if (translated && translated.length > 2 && translated !== clean) {
        return { ok: true, text: translated, source: 'mymemory' };
      }
      return { ok: false, reason: 'fail' };
    }
    if (res.status === 429 || res.status === 503) {
      return { ok: false, reason: 'rate_limit', source: 'mymemory' };
    }
    return { ok: false, reason: 'fail' };
  } catch (e) {
    return { ok: false, reason: 'fail' };
  }
}

// 带 1 次重试的翻译
async function translateText(text, googleDisabled) {
  let r = await translateOnce(text, googleDisabled);
  if (r.ok || r.reason === 'empty' || r.reason === 'quota' || r.reason === 'rate_limit') return r;
  // 普通失败重试 1 次
  await new Promise(r => setTimeout(r, 300));
  r = await translateOnce(text, googleDisabled);
  return r;
}

// ---------- 主流程 ----------
async function main() {
  console.log('开始抓取...', now);
  const [hn, gh, hf, hfSpaces, cn, reddit, arxiv] = await Promise.all([
    crawlHN(),
    crawlGitHub(),
    crawlHuggingFace(),
    crawlHfSpaces(),
    crawlCNMedia(),
    crawlReddit(),
    crawlArxiv(),
  ]);
  const fresh = [...hn, ...gh, ...hf, ...hfSpaces, ...cn, ...reddit, ...arxiv];
  console.log(`[汇总] 本次新抓取 ${fresh.length} 条（HN:${hn.length} GitHub:${gh.length} HF模型:${hf.length} HF Spaces:${hfSpaces.length} 中文媒体:${cn.length} Reddit:${reddit.length} arXiv:${arxiv.length}）`);

  // 累积模式（只增不减）：先读历史 auto，再并入本次抓取，按 id 去重，新抓取覆盖同 id 旧数据
  // 注意：同 id 新条目会覆盖旧条目，但旧条目的 summary_zh 必须保留（否则翻译成果丢失）
  const prevAuto = Array.isArray(data.auto) ? data.auto : [];
  const prevById = new Map();
  for (const it of prevAuto) {
    if (it && it.id) prevById.set(it.id, it);
  }
  const freshIds = new Set(fresh.map(f => f.id).filter(Boolean));
  const merged = [];
  for (const it of fresh) {
    if (!it || !it.id) continue;
    const old = prevById.get(it.id);
    if (old && old.summary_zh && !it.summary_zh) {
      it.summary_zh = old.summary_zh; // 保留历史翻译
    }
    merged.push(it);
  }
  for (const it of prevAuto) {
    if (it && it.id && !freshIds.has(it.id)) merged.push(it);
  }

  // 二次去重：按规范化 link 去重（解决 GitHub 大小写差异、RSS 重复收录、跨源同一仓库被 HN+HF 同时收录等问题）
  // 规则：同一规范化 link 保留 hotness 更高的；hotness 相同则保留日期更新的
  const byNormLink = new Map();
  for (const it of merged) {
    const k = normalizeLink(it.link);
    if (!k) { byNormLink.set(`__noidx_${byNormLink.size}`, it); continue; }
    const exist = byNormLink.get(k);
    if (!exist) { byNormLink.set(k, it); continue; }
    const hBetter = (it.hotness || 0) > (exist.hotness || 0);
    const hEq = (it.hotness || 0) === (exist.hotness || 0);
    const dNewer = (it.date || '') > (exist.date || '');
    if (hBetter || (hEq && dNewer)) byNormLink.set(k, it);
  }
  const auto = [...byNormLink.values()];
  console.log(`[去重] id 合并后 ${merged.length} 条，按规范化 link 二次去重后 ${auto.length} 条`);

  // ---------- 分批翻译：先翻本次 fresh，再按日期倒序补历史积压；每轮上限 MAX_TRANSLATE_PER_RUN ----------
  // 1) 构造待翻译队列：本次 fresh 中缺 summary_zh 且非中文的排前面
  // 2) 再从历史积压里按日期从新到旧补
  const freshNeedZh = fresh
    .filter(p => p && p.id && !p.summary_zh && !hasChinese(p.summary || ''))
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const backlogNeedZh = auto
    .filter(p => p && p.id && !p.summary_zh && !hasChinese(p.summary || '') && !freshIds.has(p.id))
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const queue = [...freshNeedZh, ...backlogNeedZh].slice(0, MAX_TRANSLATE_PER_RUN);
  const totalBacklog = freshNeedZh.length + backlogNeedZh.length;
  console.log(`[翻译] 待翻译队列 ${queue.length}/${totalBacklog}（fresh ${freshNeedZh.length} + 历史积压 ${backlogNeedZh.length}，本轮上限 ${MAX_TRANSLATE_PER_RUN}）`);

  let translatedCount = 0;
  let consecutiveFail = 0;
  let googleDisabled = false; // Google 遇到 429/503 后本轮内永久切 MyMemory
  let stoppedReason = '';
  for (const p of queue) {
    if (p.summary_zh) continue; // 双保险
    const r = await translateText(p.summary || '', googleDisabled);
    if (r.ok) {
      p.summary_zh = r.text;
      translatedCount++;
      consecutiveFail = 0;
    } else {
      consecutiveFail++;
      if (r.reason === 'rate_limit' && r.source === 'google') {
        console.log(`[翻译] Google 返回限流，本轮切 MyMemory 备用源`);
        googleDisabled = true;
      }
      if (r.reason === 'quota') {
        stoppedReason = 'MyMemory 额度耗尽';
        break;
      }
      if (consecutiveFail >= MAX_CONSECUTIVE_FAIL) {
        stoppedReason = `连续 ${MAX_CONSECUTIVE_FAIL} 次失败/限流`;
        break;
      }
    }
    // 每翻译 5 条休息 0.5 秒
    if (translatedCount > 0 && translatedCount % 5 === 0) {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  const remaining = totalBacklog - translatedCount;
  if (stoppedReason) {
    console.log(`[翻译] 触发限流/失败（${stoppedReason}），本轮完成 ${translatedCount} 条，剩余 ${remaining} 条留到下轮`);
  } else {
    console.log(`[翻译] 本轮翻译 ${translatedCount} 条英文简介（失败的保留原文），剩余积压 ${Math.max(0, remaining)} 条`);
  }

  const out = {
    version: 2,
    lastCrawl: now,
    crawlStats: {
      hn: hn.length,
      github: gh.length,
      hf: hf.length,
      hfSpaces: hfSpaces.length,
      cn: cn.length,
      reddit: reddit.length,
      arxiv: arxiv.length,
      fresh: fresh.length,
      translated: translatedCount,
      total: auto.length,
    },
    curated,
    auto,
  };
  writeFileSync(DATA_PATH, JSON.stringify(out, null, 2), 'utf8');
  console.log(`完成：精选 ${curated.length} 条，自动抓取累积 ${auto.length} 条（本次新增 ${fresh.length}），已写入 data.json`);

  // 生成 RSS 2.0 feed 到 docs/feed.xml（Pages 从 /docs 部署）
  try {
    const feed = buildRssFeed([...auto, ...curated]);
    writeFileSync(FEED_PATH, feed, 'utf8');
    console.log(`[RSS] 已生成 feed.xml（${feed.length} 字节，${[...auto, ...curated].length} 条候选取前 50）`);
  } catch (e) {
    console.error('[RSS] 生成 feed.xml 失败:', e.message);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
