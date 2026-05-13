#!/usr/bin/env node
"use strict";

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const PORT = 3001;

// ── Low-level HTTPS ───────────────────────────────────────────────────────────

function httpsRequest(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── GitHub GraphQL via PAT (api.github.com) ───────────────────────────────────

async function ghGQL(pat, query, variables = {}) {
  const body = JSON.stringify({ query, variables });
  const { status, body: resp } = await httpsRequest(
    {
      hostname: "api.github.com",
      path: "/graphql",
      method: "POST",
      headers: {
        Authorization: `Bearer ${pat}`,
        "Content-Type": "application/json",
        "User-Agent": "ProjectTimeLapse/1.0"
      }
    },
    body
  );
  if (status !== 200) throw new Error(`GraphQL HTTP ${status}`);
  const json = JSON.parse(resp);
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return json.data;
}

// ── URL parser ────────────────────────────────────────────────────────────────

function parseProjectUrl(url) {
  url = url.trim().replace(/\/$/, "");
  let m;
  m = url.match(/github\.com\/orgs\/([^/?#]+)\/projects\/(\d+)/);
  if (m) return { ownerTypes: ["organization"], owner: m[1], number: +m[2] };
  m = url.match(/github\.com\/users\/([^/?#]+)\/projects\/(\d+)/);
  if (m) return { ownerTypes: ["user"], owner: m[1], number: +m[2] };
  m = url.match(/github\.com\/([^/?#]+)\/projects\/(\d+)$/);
  if (m) return { ownerTypes: ["organization", "user"], owner: m[1], number: +m[2] };
  throw new Error("URL non reconnue. Format : https://github.com/orgs/ORG/projects/N");
}

// ── Fetch project metadata + items via GraphQL (PAT) ─────────────────────────

const ITEM_FRAGMENT = `fragment ItemFields on ProjectV2Item {
  id createdAt isArchived
  content { ... on Issue {
    number title createdAt
    repository { nameWithOwner }
  }}
}`;

async function fetchProjectViaGQL(pat, ownerTypes, owner, number) {
  let project = null;
  for (const ownerType of ownerTypes) {
    const ownerField = ownerType === "organization" ? "organization(login: $owner)" : "user(login: $owner)";
    try {
      const data = await ghGQL(
        pat,
        `query($owner: String!, $number: Int!, $cursor: String) {
          ${ownerField} { projectV2(number: $number) {
            id title
            fields(first: 30) { nodes {
              ... on ProjectV2SingleSelectField { id name options { id name } }
            }}
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

// ── Fetch project metadata + items via page scraping (cookie) ─────────────────

async function fetchProjectFromPage(cookie, ownerTypes, owner, number) {
  for (const ownerType of ownerTypes) {
    const urlPath = ownerType === "organization"
      ? `/orgs/${owner}/projects/${number}`
      : `/users/${owner}/projects/${number}`;

    const html = await ghFetch(cookie, urlPath);
    if (!html) { console.log(`  [proj] GET ${urlPath} → null`); continue; }

    const scriptMatch = html.match(/<script[^>]+data-target="react-app\.embeddedData"[^>]*>([\s\S]*?)<\/script>/);
    if (!scriptMatch) { console.log(`  [proj] ${urlPath}: embeddedData absent`); continue; }

    let payload;
    try { payload = JSON.parse(scriptMatch[1]).payload; }
    catch (e) { console.log(`  [proj] ${urlPath}: JSON error — ${e.message}`); continue; }

    const queries = payload?.preloadedQueries ?? [];
    console.log(`  [proj] ${urlPath}: ${queries.length} requête(s) : [${queries.map(q => q.queryName).join(", ")}]`);

    for (const q of queries) {
      const data = q?.result?.data;
      const ownerData = data?.organization ?? data?.user;
      const project = ownerData?.projectV2;
      if (!project?.title) continue;

      const allItems = project.items?.nodes ?? [];
      const totalCount = project.items?.totalCount ?? allItems.length;
      if (project.items?.pageInfo?.hasNextPage) {
        console.log(`  [proj] ⚠ pagination : ${allItems.length}/${totalCount} items dans la page`);
      } else {
        console.log(`  [proj] ${allItems.length} items chargés`);
      }
      return { project, allItems };
    }
    console.log(`  [proj] ${urlPath}: projectV2 introuvable dans les requêtes préchargées`);
  }
  return null;
}

async function fetchProject({ pat, cookie }, ownerTypes, owner, number) {
  if (cookie) {
    const result = await fetchProjectFromPage(cookie, ownerTypes, owner, number);
    if (result) return result;
    if (!pat) throw new Error("Impossible d'extraire les données du projet depuis la page GitHub. Essayez avec un PAT.");
    console.log("  [proj] scraping échoué, basculement sur PAT…");
  }
  if (!pat) throw new Error("Authentification requise : fournissez un PAT ou un cookie de session.");
  return fetchProjectViaGQL(pat, ownerTypes, owner, number);
}

// ── Build History from sorted transitions ─────────────────────────────────────

function buildHistory(transitions, itemCreatedAt) {
  if (!transitions.length) return null;
  const history = [];
  const first = transitions[0];
  if (first.fromCol && first.fromCol !== first.toCol) {
    history.push({ moment: itemCreatedAt, State: first.fromCol });
  }
  for (const t of transitions) {
    if (t.toCol) history.push({ moment: t.date, State: t.toCol });
  }
  return history.length ? history : null;
}

// ── Fetch issue page and extract timeline from embedded JSON ──────────────────
// GitHub embeds the full Relay query result as JSON in:
//   <script type="application/json" data-target="react-app.embeddedData">
// The timeline lives at:
//   payload.preloadedQueries[].result.data.repository.issue.frontTimelineItems
// Each ProjectV2ItemStatusChangedEvent has { createdAt, previousStatus, status }.
// The page uses count=15; if hasNextPage=true we re-call /_graphql with count=100.

const QUERY_HASH = "930f2e0464d1b74cdd206ed7f12d0b19"; // IssueViewerViewQuery

async function ghFetch(cookie, urlPath) {
  const headers = {
    Accept:            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "User-Agent":      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  };
  if (cookie) headers["Cookie"] = cookie;
  const { status, body } = await httpsRequest({ hostname: "github.com", path: urlPath, method: "GET", headers });
  if (status === 200) return body;
  console.log(`  [page] GET ${urlPath} → HTTP ${status}`);
  return null;
}

// Shared: extract StatusChanged events from an issue node (works for both sources).
function eventsFromIssue(issue) {
  const tl = issue?.frontTimelineItems;
  const events = (tl?.edges ?? [])
    .map(e => e.node)
    .filter(n => n?.__typename === "ProjectV2ItemStatusChangedEvent")
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  return { events, hasNextPage: tl?.pageInfo?.hasNextPage ?? false, totalCount: tl?.totalCount ?? 0 };
}

// Source 1: parse the embedded JSON from the HTML page (count=15 limit).
function extractFromPage(html, number) {
  const scriptMatch = html.match(/<script[^>]+data-target="react-app\.embeddedData"[^>]*>([\s\S]*?)<\/script>/);
  if (!scriptMatch) {
    console.log(`  [json] #${number}: embeddedData absent (page non authentifiée ?)`);
    return null;
  }
  let payload;
  try { payload = JSON.parse(scriptMatch[1]).payload; } catch (e) {
    console.log(`  [json] #${number}: erreur JSON — ${e.message}`);
    return null;
  }
  const query = payload?.preloadedQueries?.find(q => q.queryName === "IssueViewerViewQuery");
  const issue = query?.result?.data?.repository?.issue;
  if (!issue) { console.log(`  [json] #${number}: issue absente du JSON`); return null; }
  return eventsFromIssue(issue);
}

// Source 2: call /_graphql directly with count=100 to bypass the page's count=15 limit.
async function fetchFullTimeline(cookie, owner, repo, number) {
  const body = JSON.stringify({
    persistedQueryName: "IssueViewerViewQuery",
    query:              QUERY_HASH,
    variables:          { count: 100, number: +number, owner, repo },
  });
  const { status, body: resp } = await httpsRequest({
    hostname: "github.com",
    path:     "/_graphql?body=" + encodeURIComponent(body),
    method:   "GET",
    headers: {
      Cookie:             cookie,
      Accept:             "application/json",
      "User-Agent":       "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      "X-Requested-With": "XMLHttpRequest",
      Referer:            `https://github.com/${owner}/${repo}/issues/${number}`,
    },
  });
  if (status !== 200) { console.log(`  [gql]  #${number}: /_graphql → HTTP ${status}`); return null; }
  try {
    const issue = JSON.parse(resp)?.data?.repository?.issue;
    return issue ? eventsFromIssue(issue) : null;
  } catch { return null; }
}

async function fetchHistory(cookie, repoOwner, repoName, number, columns, createdAt) {
  const urlPath = `/${repoOwner}/${repoName}/issues/${number}`;
  let html = cookie ? await ghFetch(cookie, urlPath) : null;
  if (!html) html = await ghFetch(null, urlPath);
  if (!html) return null;

  let result = extractFromPage(html, number);
  if (!result) return null;

  console.log(`  [json] #${number}: ${result.events.length}/${result.totalCount} events chargés`);

  if (result.hasNextPage) {
    if (cookie) {
      console.log(`  [json] #${number}: hasNextPage — appel /_graphql count=100`);
      const full = await fetchFullTimeline(cookie, repoOwner, repoName, number);
      if (full) {
        console.log(`  [json] #${number}: ${full.events.length}/${full.totalCount} events (complet)`);
        result = full;
      } else {
        console.log(`  [json] #${number}: ⚠ /_graphql échoué, données partielles`);
      }
    } else {
      console.log(`  [json] #${number}: ⚠ hasNextPage sans cookie — ${result.events.length}/${result.totalCount} events seulement`);
    }
  }

  if (!result.events.length) return null;

  const transitions = result.events.map(ev => ({
    date:    ev.createdAt,
    fromCol: ev.previousStatus || null,
    toCol:   ev.status,
  }));

  return buildHistory(transitions, createdAt);
}

// ── Main fetch orchestrator ───────────────────────────────────────────────────

async function fetchProjectData(url, { pat, cookie }, onProgress) {
  const parsed = parseProjectUrl(url);

  onProgress("Récupération du projet GitHub…");
  const { project, allItems } = await fetchProject({ pat, cookie }, parsed.ownerTypes, parsed.owner, parsed.number);

  const ssFields = project.fields.nodes.filter((f) => f?.options?.length);
  if (!ssFields.length) throw new Error("Aucun champ Status trouvé dans ce projet.");
  const statusField = ssFields.find((f) => /^(status|statut|colonne?|column|état|state)$/i.test(f.name)) ?? ssFields[0];
  const columns = statusField.options.map((o) => o.name);

  const validItems = allItems.filter((item) => !item.isArchived && item.content?.number);
  onProgress(`"${project.title}" — ${validItems.length} issues, colonnes : ${columns.join(", ")}`);

  const issues = [];
  for (let i = 0; i < validItems.length; i++) {
    const item = validItems[i];
    const content = item.content;
    onProgress(`Issue ${i + 1}/${validItems.length} — #${content.number} ${content.title}`);

    const [repoOwner, repoName] = content.repository.nameWithOwner.split("/");
    const history = await fetchHistory(cookie, repoOwner, repoName, content.number, columns, item.createdAt);
    if (history?.length) {
      issues.push({ issueID: content.number, issueName: content.title, History: history });
    }
  }

  return {
    meta: { project: project.title, url, fetchedAt: new Date().toISOString(), columns },
    issues
  };
}

// ── HTTP server ───────────────────────────────────────────────────────────────

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

function readBody(req) {
  return new Promise((ok) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => {
      try {
        ok(JSON.parse(s));
      } catch {
        ok({});
      }
    });
  });
}

function serveFile(res, filePath, contentType) {
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { ...CORS, "Content-Type": contentType });
    res.end(content);
  } catch {
    res.writeHead(404, CORS);
    res.end("Not found");
  }
}

function sseWriter(res) {
  res.writeHead(200, {
    ...CORS,
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });
  return {
    progress: (msg) => res.write(`event: progress\ndata: ${JSON.stringify({ message: msg })}\n\n`),
    done: (data) => res.write(`event: done\ndata: ${JSON.stringify({ data })}\n\n`),
    error: (msg) => res.write(`event: error\ndata: ${JSON.stringify({ message: msg })}\n\n`),
    end: () => res.end()
  };
}

http
  .createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS);
      return res.end();
    }

    const { pathname } = new URL(req.url, `http://localhost:${PORT}`);

    if (req.method === "GET" && pathname === "/") {
      return serveFile(res, path.join(__dirname, "index.html"), "text/html; charset=utf-8");
    }
    if (req.method === "POST" && pathname === "/fetch") {
      const { url, pat, cookie } = await readBody(req);
      if (!url || (!pat && !cookie)) {
        res.writeHead(400, { ...CORS, "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "url et (pat ou cookie) requis" }));
      }

      const sse = sseWriter(res);
      try {
        const data = await fetchProjectData(url, { pat: pat || null, cookie: cookie || null }, (msg) => {
          console.log(" ", msg);
          sse.progress(msg);
        });
        sse.done(data);
      } catch (err) {
        console.error("  Erreur:", err.message);
        sse.error(err.message);
      } finally {
        sse.end();
      }
      return;
    }

    res.writeHead(404, CORS);
    res.end("Not found");
  })
  .listen(PORT, "127.0.0.1", () => {
    console.log(`\n  ProjectTimeLapse → http://localhost:${PORT}`);
    console.log("  Ctrl+C pour arrêter.\n");
  });
