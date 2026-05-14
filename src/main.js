'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { Document, Packer, Paragraph, TextRun, ImageRun, HeadingLevel, BorderStyle } = require('docx');

// ── Low-level HTTPS (text) ────────────────────────────────────────────────────

function httpsRequest(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── GitHub GraphQL via PAT ────────────────────────────────────────────────────

async function ghGQL(pat, query, variables = {}) {
  const body = JSON.stringify({ query, variables });
  const { status, body: resp } = await httpsRequest(
    {
      hostname: 'api.github.com',
      path: '/graphql',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${pat}`,
        'Content-Type': 'application/json',
        'User-Agent': 'GistoDoc/1.0',
      },
    },
    body
  );
  if (status !== 200) throw new Error(`GraphQL HTTP ${status}`);
  const json = JSON.parse(resp);
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return json.data;
}

// ── Binary fetch (follows redirects, strips auth on redirect) ─────────────────

function fetchBinary(urlString, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(urlString); } catch (e) { return reject(e); }
    const req = https.request(
      { hostname: url.hostname, path: url.pathname + url.search, method: 'GET',
        headers: { 'User-Agent': 'GistoDoc/1.0', ...extraHeaders } },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          return fetchBinary(res.headers.location, {}).then(resolve).catch(reject);
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on('end', () => resolve({
          status: res.statusCode,
          contentType: res.headers['content-type'] || 'image/png',
          buffer: Buffer.concat(chunks),
        }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// ── Image fetching ────────────────────────────────────────────────────────────
// Returns Map<url, { buffer, contentType, origWidth, origHeight }>

async function fetchIssueImages(body, pat) {
  const urlMeta = new Map();

  for (const m of body.matchAll(/<img\b([^>]*?)>/g)) {
    const attrs = m[1];
    const srcM = attrs.match(/src="(https?:\/\/[^"]+)"/);
    if (!srcM) continue;
    const wM = attrs.match(/width="(\d+)"/);
    const hM = attrs.match(/height="(\d+)"/);
    urlMeta.set(srcM[1], { origWidth: wM ? +wM[1] : null, origHeight: hM ? +hM[1] : null });
  }
  for (const m of body.matchAll(/!\[[^\]]*\]\((https?:\/\/[^)]+)\)/g)) {
    if (!urlMeta.has(m[1])) urlMeta.set(m[1], { origWidth: null, origHeight: null });
  }
  if (!urlMeta.size) return new Map();

  const authHeaders = pat ? { Authorization: `Bearer ${pat}` } : {};
  const result = new Map();
  for (const [url, meta] of urlMeta) {
    try {
      const { status, contentType, buffer } = await fetchBinary(url, authHeaders);
      if (status === 200 && buffer.length) {
        result.set(url, { buffer, contentType: contentType.split(';')[0].trim(), ...meta });
      }
    } catch { /* keep URL on error */ }
  }
  return result;
}

// ── URL parser ────────────────────────────────────────────────────────────────

function parseProjectUrl(url) {
  url = url.trim().replace(/\/$/, '');
  let m;
  m = url.match(/github\.com\/orgs\/([^/?#]+)\/projects\/(\d+)/);
  if (m) return { ownerTypes: ['organization'], owner: m[1], number: +m[2] };
  m = url.match(/github\.com\/users\/([^/?#]+)\/projects\/(\d+)/);
  if (m) return { ownerTypes: ['user'], owner: m[1], number: +m[2] };
  m = url.match(/github\.com\/([^/?#]+)\/projects\/(\d+)$/);
  if (m) return { ownerTypes: ['organization', 'user'], owner: m[1], number: +m[2] };
  throw new Error("URL non reconnue. Format : https://github.com/orgs/ORG/projects/N");
}

// ── Fetch project items via GraphQL ──────────────────────────────────────────

const ITEM_FRAGMENT = `fragment ItemFields on ProjectV2Item {
  id isArchived
  content { ... on Issue {
    number title body
    labels(first: 20) { nodes { name } }
    repository { nameWithOwner }
  }}
}`;

async function fetchProjectItems(pat, ownerTypes, owner, number) {
  let project = null;
  for (const ownerType of ownerTypes) {
    const ownerField = ownerType === 'organization' ? 'organization(login: $owner)' : 'user(login: $owner)';
    try {
      const data = await ghGQL(
        pat,
        `query($owner: String!, $number: Int!, $cursor: String) {
          ${ownerField} { projectV2(number: $number) {
            id title
            items(first: 100, after: $cursor) {
              pageInfo { hasNextPage endCursor }
              nodes { ...ItemFields }
            }
          }}
        } ${ITEM_FRAGMENT}`,
        { owner, number, cursor: null }
      );
      const ownerData = data.organization ?? data.user;
      if (ownerData?.projectV2) { project = ownerData.projectV2; break; }
    } catch { /* try next owner type */ }
  }
  if (!project) throw new Error("Projet introuvable. Vérifiez l'URL et le PAT.");

  const allItems = [...project.items.nodes];
  let pi = project.items.pageInfo;
  while (pi.hasNextPage) {
    const data = await ghGQL(
      pat,
      `query($projectId: ID!, $cursor: String) {
        node(id: $projectId) { ... on ProjectV2 {
          items(first: 100, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes { ...ItemFields }
          }
        }}
      } ${ITEM_FRAGMENT}`,
      { projectId: project.id, cursor: pi.endCursor }
    );
    const page = data.node.items;
    allItems.push(...page.nodes);
    pi = page.pageInfo;
  }
  return { project, allItems };
}

// ── Fetch orchestrator ────────────────────────────────────────────────────────

async function fetchProjectData(url, pat, tag, onProgress) {
  const parsed = parseProjectUrl(url);

  onProgress('Récupération du projet GitHub…');
  const { project, allItems } = await fetchProjectItems(pat, parsed.ownerTypes, parsed.owner, parsed.number);

  const normalizedTag = tag?.trim().toLowerCase() || '';
  const validItems = allItems.filter((item) => {
    if (item.isArchived || !item.content?.number) return false;
    if (normalizedTag) {
      const labels = item.content.labels?.nodes?.map((l) => l.name.toLowerCase()) ?? [];
      return labels.includes(normalizedTag);
    }
    return true;
  });
  const tagNote = normalizedTag ? ` (label: "${tag}")` : '';
  onProgress(`"${project.title}" — ${validItems.length} issues${tagNote}`);

  const issues = validItems.map((item) => {
    const c = item.content;
    return { number: c.number, title: c.title, body: c.body ?? '', images: new Map() };
  });
  issues.sort((a, b) => a.number - b.number);

  onProgress('Téléchargement des images…');
  let totalImages = 0;
  for (const issue of issues) {
    const imgCount =
      [...issue.body.matchAll(/<img\b[^>]*?\bsrc="https?:\/\//g)].length +
      [...issue.body.matchAll(/!\[[^\]]*\]\(https?:\/\//g)].length;
    if (imgCount > 0) {
      onProgress(`Images #${issue.number} — ${imgCount} image${imgCount !== 1 ? 's' : ''}…`);
      issue.images = await fetchIssueImages(issue.body, pat);
      totalImages += imgCount;
    }
  }
  if (totalImages > 0) onProgress(`${totalImages} image${totalImages !== 1 ? 's' : ''} téléchargée${totalImages !== 1 ? 's' : ''}.`);

  return { projectTitle: project.title, url, fetchedAt: new Date().toISOString(), issues };
}

// ── Markdown formatter ────────────────────────────────────────────────────────

function applyImagesMarkdown(body, images) {
  let result = body.replace(/(<img\b[^>]*?)src="(https?:\/\/[^"]+)"/g, (match, prefix, url) => {
    const img = images.get(url);
    if (!img) return match;
    const clean = prefix.replace(/\s*(width|height)="[^"]*"/gi, '');
    return `${clean}src="data:${img.contentType};base64,${img.buffer.toString('base64')}"`;
  });
  result = result.replace(/!\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g, (match, alt, url) => {
    const img = images.get(url);
    return img ? `![${alt}](data:${img.contentType};base64,${img.buffer.toString('base64')})` : match;
  });
  return result;
}

function formatMarkdown({ projectTitle, url, fetchedAt, issues }) {
  const date = new Date(fetchedAt).toLocaleDateString('fr-CH', {
    day: '2-digit', month: '2-digit', year: 'numeric',
  });
  const lines = [
    `# ${projectTitle}`, '',
    `*Exporté le ${date} — ${issues.length} issue${issues.length !== 1 ? 's' : ''}*`,
    `*Source : ${url}*`, '', '---', '',
  ];
  for (const issue of issues) {
    lines.push(`## #${issue.number} — ${issue.title}`, '');
    if (issue.body.trim()) lines.push(applyImagesMarkdown(issue.body, issue.images).trim(), '');
    lines.push('---', '');
  }
  return lines.join('\n');
}

// ── Word formatter ────────────────────────────────────────────────────────────

function parseInline(text) {
  const runs = [];
  const re = /\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|\*(.+?)\*|`([^`]+)`|~~(.+?)~~|\[([^\]]+)\]\([^)]+\)|([^*`~[\]]+)/gs;
  for (const m of text.matchAll(re)) {
    if (m[1]) runs.push(new TextRun({ text: m[1], bold: true, italics: true }));
    else if (m[2]) runs.push(new TextRun({ text: m[2], bold: true }));
    else if (m[3]) runs.push(new TextRun({ text: m[3], italics: true }));
    else if (m[4]) runs.push(new TextRun({ text: m[4], font: { name: 'Courier New' } }));
    else if (m[5]) runs.push(new TextRun({ text: m[5], strike: true }));
    else if (m[6]) runs.push(new TextRun({ text: m[6] }));
    else if (m[7]) runs.push(new TextRun({ text: m[7] }));
  }
  return runs.length ? runs : [new TextRun({ text })];
}

function parseBodyToDocxBlocks(body, images) {
  const blocks = [];
  const segments = body.split(/(<img\b[^>]*?\/?>|!\[[^\]]*\]\(https?:\/\/[^)]+\))/g);

  for (const seg of segments) {
    // ── Image segment ──
    const htmlSrc = seg.match(/^<img\b[^>]*?src="(https?:\/\/[^"]+)"/);
    const mdSrc   = seg.match(/^!\[[^\]]*\]\((https?:\/\/[^)]+)\)/);
    const imgUrl  = htmlSrc?.[1] ?? mdSrc?.[1];

    if (imgUrl) {
      const img = images.get(imgUrl);
      if (img) {
        const MAX_W = 500;
        const origW = img.origWidth  ?? MAX_W;
        const origH = img.origHeight ?? Math.round(MAX_W * 0.7);
        const scale = Math.min(1, MAX_W / origW);
        blocks.push(new Paragraph({
          children: [new ImageRun({
            data: img.buffer,
            transformation: { width: Math.round(origW * scale), height: Math.round(origH * scale) },
          })],
        }));
      }
      continue;
    }

    // ── Text segment ──
    for (const line of seg.split('\n')) {
      const t = line.trimEnd();

      // Heading
      const hm = t.match(/^(#{1,6})\s+(.*)/);
      if (hm) {
        const LEVELS = [, HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3,
                         HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];
        blocks.push(new Paragraph({ heading: LEVELS[hm[1].length], children: parseInline(hm[2]) }));
        continue;
      }

      // Horizontal rule
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) {
        blocks.push(new Paragraph({
          text: '',
          border: { bottom: { color: 'CCCCCC', style: BorderStyle.SINGLE, size: 4, space: 1 } },
        }));
        continue;
      }

      // Bullet list
      const bm = t.match(/^[-*+]\s+(.*)/);
      if (bm) {
        blocks.push(new Paragraph({ children: [new TextRun({ text: '• ' }), ...parseInline(bm[1])] }));
        continue;
      }

      // Numbered list
      const nm = t.match(/^(\d+)\.\s+(.*)/);
      if (nm) {
        blocks.push(new Paragraph({ children: [new TextRun({ text: `${nm[1]}. ` }), ...parseInline(nm[2])] }));
        continue;
      }

      // Empty line → spacer paragraph
      if (!t) { blocks.push(new Paragraph({ text: '' })); continue; }

      // Regular paragraph
      blocks.push(new Paragraph({ children: parseInline(t) }));
    }
  }
  return blocks;
}

async function buildDocxDocument({ projectTitle, url, fetchedAt, issues }) {
  const date = new Date(fetchedAt).toLocaleDateString('fr-CH', {
    day: '2-digit', month: '2-digit', year: 'numeric',
  });

  const children = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: projectTitle })] }),
    new Paragraph({ children: [new TextRun({ text: `Exporté le ${date} — ${issues.length} issue${issues.length !== 1 ? 's' : ''}`, italics: true })] }),
    new Paragraph({ children: [new TextRun({ text: `Source : ${url}`, italics: true })] }),
    new Paragraph({ text: '' }),
  ];

  for (const issue of issues) {
    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_1,
      children: [new TextRun({ text: `#${issue.number} — ${issue.title}` })],
    }));
    if (issue.body.trim()) children.push(...parseBodyToDocxBlocks(issue.body, issue.images));
    children.push(new Paragraph({ text: '' }));
  }

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

// ── Electron app ──────────────────────────────────────────────────────────────

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 640,
    height: 520,
    title: 'Git Stories to Document',
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.loadFile('index.html');
}

app.whenReady().then(() => {
  ipcMain.handle('export', async (event, { url, pat, tag, format }) => {
    try {
      const data = await fetchProjectData(url, pat, tag, (msg) => {
        console.log(' ', msg);
        event.sender.send('fetch-progress', msg);
      });

      event.sender.send('fetch-progress', 'Génération du fichier…');

      const safeName = data.projectTitle.replace(/[^a-z0-9\-_. ]/gi, '_').trim() || 'export';
      const ext = format === 'docx' ? 'docx' : 'md';
      const filterName = format === 'docx' ? 'Word' : 'Markdown';

      const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
        title: 'Enregistrer',
        defaultPath: `${safeName}.${ext}`,
        filters: [{ name: filterName, extensions: [ext] }],
      });

      if (canceled || !filePath) return { success: false, canceled: true };

      if (format === 'docx') {
        const buffer = await buildDocxDocument(data);
        fs.writeFileSync(filePath, buffer);
      } else {
        fs.writeFileSync(filePath, formatMarkdown(data), 'utf8');
      }

      return { success: true, filePath, count: data.issues.length };
    } catch (err) {
      console.error('  Erreur:', err.message);
      return { success: false, error: err.message };
    }
  });

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
