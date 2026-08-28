// AI 热门项目雷达 - 自动抓取脚本
// 数据源：Hacker News + GitHub Search API
// 零依赖，Node 18+ 内置 fetch
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = join(__dirname, 'data.json');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const UA = 'ai-hot-radar/1.0 (+https://github.com/yyds8170-ctrl/ai-hot-radar)';

// ---------- 分类规则 ----------
const CATEGORIES = [
  {
    key: 'ai-clothing',
    name: 'AI服装换装',
    keywords: ['virtual-try-on', 'virtual try-on', 'vton', 'try-on', 'tryon', 'fashion-ai', 'fashion ai', 'wardrobe', 'outfit', 'clothing', 'garment', '换装', '试衣', '穿搭'],
  },
  {
    key: 'ai-video',
    name: 'AI视频生成',
    keywords: ['text-to-video', 'image-to-video', 'video generation', 'video-generator', 'video model', 'veo', 'kling', 'seedance', 'runway gen', 'sora', 'hailuo', 'minimax video', 'wan2', '视频生成', 'ai video'],
  },
  {
    key: 'ai-image',
    name: 'AI图像/电商设计',
    keywords: ['text-to-image', 'image-generation', 'image generation', 'image-editing', 'image editing', 'nano banana', 'seedream', 'comfyui', 'stable-diffusion', 'stable diffusion', 'flux', 'midjourney', 'photoshop plugin', 'ecommerce image', 'product photo', '文生图', '作图', '修图'],
  },
  {
    key: 'ai-model',
    name: 'AI新模型',
    keywords: ['open-weight', 'open weight', 'open-source llm', 'open-weights', 'llm release', 'new model', 'foundation model', 'gpt-', 'claude-', 'gemini-', 'qwen', 'deepseek', 'llama', 'mistral', 'grok', 'kimi', 'model release', '大模型', '开源模型'],
  },
  {
    key: 'ai-tool',
    name: '效率/Agent工具',
    keywords: ['ai-agent', 'ai agent', 'agentic', 'mcp', 'model context protocol', 'coding agent', 'copilot', 'cursor', 'claude code', 'codex', 'workflow automation', 'productivity ai', 'llm tool', 'rag framework', 'agent framework', '智能体'],
  },
];

// 必须命中的 AI 大词（HN 标题过滤用，避免无关内容）
const AI_HINT = /\b(ai|llm|gpt|agent|agents|agentic|mcp|model|models|diffusion|transformer|neural|machine learning|deep learning|genai|generative|chatbot|copilot|claude|gemini|openai|anthropic|deepseek|qwen|comfyui|veo|kling|sora|runway|vton|try-on|inference|embedding|rag)\b|人工智能|大模型|机器学习|深度学习|生成式|智能体|多模态|算力|大语言模型|开源模型/i;

function classify(text) {
  const t = text.toLowerCase();
  for (const cat of CATEGORIES) {
    for (const kw of cat.keywords) {
      if (t.includes(kw.toLowerCase())) return cat.key;
    }
  }
  return 'ai-tool';
}

const now = new Date().toISOString();
const today = now.slice(0, 10);

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

// ---------- GitHub ----------
async function crawlGitHub() {
  const items = [];
  const seen = new Set();
  const keywords = [
    'virtual-try-on', 'vton', 'fashion-ai',
    'text-to-video', 'ai-video-generation', 'video-generation',
    'text-to-image', 'image-generation', 'comfyui',
    'ai-agent', 'llm-agent', 'agent-framework',
    'mcp-server', 'model-context-protocol',
    'open-source-llm', 'local-llm',
  ];
  try {
    const twoMonthsAgo = new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const headers = { Accept: 'application/vnd.github+json' };
    if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
    let remaining = null;
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
          items.push({
            id: `gh-${repo.full_name}`,
            name: repo.full_name,
            category: classify(text),
            tags: ['GitHub', repo.language].filter(Boolean).concat(repo.topics || []).slice(0, 6),
            summary: repo.description || '(无简介)',
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
    // 按 star 排序取 top 40
    items.sort((a, b) => {
      const sa = parseInt((a.description.match(/⭐ ([\d,]+)/) || [])[1]?.replace(/,/g, '') || '0', 10);
      const sb = parseInt((b.description.match(/⭐ ([\d,]+)/) || [])[1]?.replace(/,/g, '') || '0', 10);
      return sb - sa;
    });
    console.log(`[GitHub] 抓取 ${items.length} 个仓库（去重后），取 top 40；剩余限额 ${remaining}`);
    return items.slice(0, 40);
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
      items.push({
        id: `hf-${m.id}`,
        name: m.id,
        category: classify(text),
        tags: ['Hugging Face', m.pipeline_tag].filter(Boolean).concat((m.tags || []).slice(0, 4)).slice(0, 6),
        summary: m.cardData?.short_description || m.pipeline_tag || '(HF 热门模型)',
        description: `⬇ ${downloads.toLocaleString()} 下载 · ❤ ${(m.likes || 0).toLocaleString()} 点赞 · ${m.pipeline_tag || '多模态'}`,
        usage: '',
        link,
        source: 'Hugging Face',
        hotness: Math.min(5, Math.max(1, Math.round(Math.log10(downloads + 1) * 0.8))),
        date: (m.lastModified || '').slice(0, 10) || today,
        sourceType: 'auto',
      });
    }
    console.log(`[HF] 抓取 ${items.length} 个热门模型`);
  } catch (e) {
    console.error('[HF] 抓取失败:', e.message);
  }
  return items;
}
// ---------- 中文 AI 媒体（机器之心 / 量子位）----------
async function crawlCNMedia() {
  const items = [];
  const sources = [
    { name: '新智元', url: 'https://www.aiera.com.cn/feed' },
    { name: '量子位', url: 'https://www.qbitai.com/feed' },
  ];
  for (const src of sources) {
    let count = 0;
    try {
      const res = await fetch(src.url, { headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error(`${res.status} for ${src.url}`);
      const xml = await res.text();
      const re = /<item>([\s\S]*?)<\/item>/g;
      let m;
      while ((m = re.exec(xml)) !== null && count < 10) {
        const block = m[1];
        const get = (tag) => {
          const hit = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
          return hit ? hit[1] : '';
        };
        let title = get('title').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, '$1').replace(/<[^>]*>/g, '').trim();
        const link = get('link').trim();
        const pubDate = get('pubDate').trim();
        let desc = get('description').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, '$1').replace(/<[^>]*>/g, '').replace(/&[a-zA-Z#0-9]+;/g, ' ').trim().slice(0, 180);
        if (!title || !link) continue;
        // 中文媒体本身就是 AI 媒体，若标题毫无 AI 迹象则跳过
        if (!AI_HINT.test(title)) continue;
        items.push({
          id: `cn-${Buffer.from(link).toString('base64').slice(0, 12)}`,
          name: title.slice(0, 80),
          category: classify(title),
          tags: [src.name, '中文AI'],
          summary: title.slice(0, 100),
          description: desc || title.slice(0, 80),
          usage: '',
          link,
          source: src.name,
          hotness: 3,
          date: pubDate ? new Date(pubDate).toISOString().slice(0, 10) : today,
          sourceType: 'auto',
        });
        count++;
      }
      console.log(`[${src.name}] 抓取 ${count} 条`);
    } catch (e) {
      console.error(`[${src.name}] 抓取失败:`, e.message);
    }
  }
  return items;
}
// ---------- 主流程 ----------
async function main() {
  console.log('开始抓取...', now);
  const [hn, gh, hf, cn] = await Promise.all([crawlHN(), crawlGitHub(), crawlHuggingFace(), crawlCNMedia()]);
  const fresh = [...hn, ...gh, ...hf, ...cn];
  // 累积模式（只增不减）：先读历史 auto，再并入本次抓取，按 id 去重，新抓取覆盖同 id 旧数据
  const prevAuto = Array.isArray(data.auto) ? data.auto : [];
  const byId = new Map();
  for (const it of prevAuto) {
    if (it && it.id) byId.set(it.id, it);
  }
  for (const it of fresh) {
    if (it && it.id) byId.set(it.id, it);
  }
  const auto = [...byId.values()];

  const out = {
    version: 2,
    lastCrawl: now,
    crawlStats: { hn: hn.length, github: gh.length, hf: hf.length, cn: cn.length, fresh: fresh.length, total: auto.length },
    curated,
    auto,
  };
  writeFileSync(DATA_PATH, JSON.stringify(out, null, 2), 'utf8');
  console.log(`完成：精选 ${curated.length} 条，自动抓取累积 ${auto.length} 条（本次新增 ${fresh.length}），已写入 data.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
