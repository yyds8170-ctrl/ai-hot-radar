// AI 热门项目雷达 - 自动抓取脚本
// 数据源：Hacker News + GitHub Search API + Hugging Face 模型/Spaces + 中文AI媒体 + Reddit r/LocalLLaMA + arXiv
// 零依赖，Node 18+ 内置 fetch
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = join(__dirname, 'data.json');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const UA = 'ai-hot-radar/1.0 (+https://github.com/yyds8170-ctrl/ai-hot-radar)';
// 浏览器 UA，用于需要伪装浏览器的源（Reddit、RSS 等）
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

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
    keywords: ['text-to-video', 'image-to-video', 'video generation', 'video-generator', 'video model', 'veo', 'kling', 'seedance', 'runway gen', 'sora', 'hailuo', 'minimax video', 'wan2', 'video diffusion', 'text to video', '视频生成', 'ai video'],
  },
  {
    key: 'ai-image',
    name: 'AI图像/电商设计',
    keywords: ['text-to-image', 'image-generation', 'image generation', 'image-editing', 'image editing', 'nano banana', 'seedream', 'comfyui', 'stable-diffusion', 'stable diffusion', 'flux', 'midjourney', 'photoshop plugin', 'ecommerce image', 'product photo', 'diffusion model', '文生图', '作图', '修图'],
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
    'text-to-video stars:>500',
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
      const runs = s.lastModified ? 1 : 0;
      items.push({
        id: `hf-space-${s.id}`,
        name: s.id.split('/').pop(),
        category: classify(text),
        tags: ['HF Spaces', s.pipeline_tag].filter(Boolean).concat((s.tags || []).slice(0, 4)).slice(0, 6),
        summary: s.cardData?.short_description || s.pipeline_tag || '(HF 热门应用)',
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

// ---------- 中文 AI 媒体（新智元 / 量子位 / 机器之心） ----------
async function crawlCNMedia() {
  const items = [];
  const sources = [
    { name: '新智元', url: 'https://www.aiera.com.cn/feed' },
    { name: '量子位', url: 'https://www.qbitai.com/feed' },
    { name: '机器之心', url: 'https://www.jiqizhixin.com/rss' },
  ];
  for (const src of sources) {
    let count = 0;
    // 失败重试一次
    for (let attempt = 0; attempt < 2 && count === 0; attempt++) {
      try {
        const res = await fetch(src.url, {
          headers: { 'User-Agent': BROWSER_UA, Accept: 'application/rss+xml, application/xml, text/xml, */*' },
        });
        if (!res.ok) throw new Error(`${res.status} for ${src.url}`);
        const xml = await res.text();
        const re = /<item>([\s\S]*?)<\/item>/g;
        let m;
        while ((m = re.exec(xml)) !== null && count < 15) {
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
            id: `cn-${createHash('sha1').update(link).digest('hex').slice(0, 16)}`,
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
  }
  return items;
}

// ---------- Reddit r/LocalLLaMA 热帖 ----------
async function crawlReddit() {
  const items = [];
  try {
    // Reddit 要求 UA 头且不能用默认 fetch UA，否则 403
    const url = 'https://www.reddit.com/r/LocalLLaMA/hot.json?limit=30';
    const res = await fetch(url, {
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'application/json',
      },
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const json = await res.json();
    const posts = json?.data?.children || [];
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
        summary: d.title.slice(0, 120),
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
    console.error('[Reddit] 抓取失败:', e.message);
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
function hasChinese(s) {
  return /[\u4e00-\u9fff]/.test(s || '');
}
async function translateText(text) {
  if (!text || !text.trim() || hasChinese(text)) return null;
  const clean = text.trim().slice(0, 500);
  // 主源：Google Translate 免费接口（GitHub 服务器在国外可访问）
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=${encodeURIComponent(clean)}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA } });
    clearTimeout(timer);
    if (res.ok) {
      const data = await res.json();
      const translated = (data[0] || []).map(seg => seg[0] || '').join('').trim();
      if (translated && translated.length > 2 && translated !== clean) return translated;
    }
  } catch (e) { /* 静默失败，切备用源 */ }
  // 备用源：MyMemory 免费 API
  try {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(clean)}&langpair=en|zh-CN`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA } });
    clearTimeout(timer);
    if (res.ok) {
      const data = await res.json();
      const translated = (data?.responseData?.translatedText || '').trim();
      if (translated && translated.length > 2 && translated !== clean) return translated;
    }
  } catch (e) { /* 静默失败，保留原文 */ }
  return null;
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
  const prevAuto = Array.isArray(data.auto) ? data.auto : [];
  const byId = new Map();
  for (const it of prevAuto) {
    if (it && it.id) byId.set(it.id, it);
  }
  for (const it of fresh) {
    if (it && it.id) byId.set(it.id, it);
  }
  const auto = [...byId.values()];

  // 免费翻译英文简介（全降级保护：超时/失败自动切备用源，再失败保留原文，不影响主流程）
  let translatedCount = 0;
  for (const p of auto) {
    if (p.summary_zh) continue; // 已有中文，跳过
    if (hasChinese(p.summary || '')) continue; // 已是中文
    const zh = await translateText(p.summary || '');
    if (zh) {
      p.summary_zh = zh;
      translatedCount++;
    }
    // 每翻译 5 条休息 0.5 秒，避免触发限流
    if (translatedCount > 0 && translatedCount % 5 === 0) {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  console.log(`[翻译] 本次翻译 ${translatedCount} 条英文简介（失败的保留原文）`);

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
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
