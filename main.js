'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ── Low-level HTTPS ───────────────────────────────────────────────────────────

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

// ── Binary fetch (images, follows redirects) ─────────────────────────────────

function fetchBinary(urlString, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(urlString); } catch (e) { return reject(e); }
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'GET',
      headers: { 'User-Agent': 'GistoDoc/1.0', ...extraHeaders },
    };
    const req = https.request(options, (res) => {
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
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Image embedding (replaces URLs with base64 data URIs) ────────────────────

async function embedImages(body, pat) {
  const urls = new Set();
  for (const m of body.matchAll(/<img\b[^>]*?\bsrc="(https?:\/\/[^"]+)"/g)) urls.add(m[1]);
  for (const m of body.matchAll(/!\[[^\]]*\]\((https?:\/\/[^)]+)\)/g)) urls.add(m[1]);
  if (!urls.size) return body;

  const cache = new Map();
  const authHeaders = pat ? { Authorization: `Bearer ${pat}` } : {};
  for (const url of urls) {
    try {
      const { status, contentType, buffer } = await fetchBinary(url, authHeaders);
      if (status === 200 && buffer.length) {
        const mime = contentType.split(';')[0].trim();
        cache.set(url, `data:${mime};base64,${buffer.toString('base64')}`);
      }
    } catch { /* keep original URL on error */ }
  }

  let result = body.replace(/(<img\b[^>]*?)src="(https?:\/\/[^"]+)"/g, (match, prefix, url) => {
    const d = cache.get(url);
    if (!d) return match;
    const clean = prefix.replace(/\s*(width|height)="[^"]*"/gi, '');
    return `${clean}src="${d}"`;
  });
  result = result.replace(/!\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g, (match, alt, url) => {
    const d = cache.get(url);
    return d ? `![${alt}](${d})` : match;
  });
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

async function fetchProjectData(url, pat, onProgress) {
  const parsed = parseProjectUrl(url);

  onProgress('Récupération du projet GitHub…');
  const { project, allItems } = await fetchProjectItems(pat, parsed.ownerTypes, parsed.owner, parsed.number);

  const validItems = allItems.filter((item) => !item.isArchived && item.content?.number);
  onProgress(`"${project.title}" — ${validItems.length} issues`);

  const issues = validItems.map((item) => {
    const c = item.content;
    return { number: c.number, title: c.title, body: c.body ?? '' };
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
      issue.body = await embedImages(issue.body, pat);
      totalImages += imgCount;
    }
  }
  if (totalImages > 0) onProgress(`${totalImages} image${totalImages !== 1 ? 's' : ''} intégrée${totalImages !== 1 ? 's' : ''}.`);

  return { projectTitle: project.title, url, fetchedAt: new Date().toISOString(), issues };
}

// ── Markdown formatter ────────────────────────────────────────────────────────

function formatMarkdown({ projectTitle, url, fetchedAt, issues }) {
  const date = new Date(fetchedAt).toLocaleDateString('fr-CH', {
    day: '2-digit', month: '2-digit', year: 'numeric',
  });
  const lines = [
    `# ${projectTitle}`,
    '',
    `*Exporté le ${date} — ${issues.length} issue${issues.length !== 1 ? 's' : ''}*`,
    `*Source : ${url}*`,
    '',
    '---',
    '',
  ];
  for (const issue of issues) {
    lines.push(`## #${issue.number} — ${issue.title}`, '');
    if (issue.body.trim()) lines.push(issue.body.trim(), '');
    lines.push('---', '');
  }
  return lines.join('\n');
}

// ── Electron app ──────────────────────────────────────────────────────────────

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 640,
    height: 520,
    title: 'Git Stories to Markdown',
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
  ipcMain.handle('export-markdown', async (event, { url, pat }) => {
    try {
      const data = await fetchProjectData(url, pat, (msg) => {
        console.log(' ', msg);
        event.sender.send('fetch-progress', msg);
      });

      event.sender.send('fetch-progress', 'Formatage Markdown…');
      const md = formatMarkdown(data);

      const safeName = data.projectTitle.replace(/[^a-z0-9\-_. ]/gi, '_').trim() || 'export';
      const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
        title: 'Exporter en Markdown',
        defaultPath: `${safeName}.md`,
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      });

      if (canceled || !filePath) return { success: false, canceled: true };

      fs.writeFileSync(filePath, md, 'utf8');
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
