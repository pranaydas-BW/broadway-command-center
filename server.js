/* ===================================================================
   BROADWAY COMMAND CENTER — server
   ---------------------------------------------------------------
   Serves the dashboard UI (public/index.html) and a small JSON API
   for reading/writing the list of dashboard links.

   WHY GITHUB IS THE DATABASE
   Render's free web services do not guarantee a persistent local
   disk across restarts. Rather than risk silently losing admin
   edits, every write here commits an updated links.json straight to
   this repo via the GitHub Contents API. That gives us:
     - durability (it's just a file in git)
     - a free audit trail (every add/edit/delete is a commit)
     - no extra infrastructure or paid disk needed

   REQUIRED ENVIRONMENT VARIABLES (set these in Render, not in code)
     GITHUB_OWNER      e.g. "pranaydas-BW"
     GITHUB_REPO       e.g. "broadway-command-center"
     GITHUB_BRANCH     e.g. "main"                (optional, defaults to main)
     GITHUB_TOKEN      a GitHub Personal Access Token with
                       "Contents: Read and write" permission on this repo
     GITHUB_DATA_PATH  e.g. "links.json"          (optional, this default is fine)
     ADMIN_PASSCODE    whatever passcode your team uses to unlock admin mode
=================================================================== */

import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  GITHUB_OWNER,
  GITHUB_REPO,
  GITHUB_BRANCH = "main",
  GITHUB_TOKEN,
  GITHUB_DATA_PATH = "links.json",
  ADMIN_PASSCODE,
  PORT = 3000
} = process.env;

const DEFAULT_LINKS = [
  {
    id: "incentive",
    title: "Incentive",
    url: "https://storeops.broadwaylive.in/",
    description: "Store-level staff incentive and variable pay tracking.",
    color: "amber",
    locked: true
  },
  {
    id: "stock-finder",
    title: "Stock Finder",
    url: "https://stock-finder-0fm2.onrender.com/",
    description: "Barcode-based inventory lookup across Hyderabad, Delhi & Pune.",
    color: "sky",
    locked: true
  },
  {
    id: "promo-dashboard",
    title: "Promo Dashboard",
    url: "https://promo-hub.onrender.com/",
    description: "Live view of running promotions and offer performance.",
    color: "pink",
    locked: true
  }
];

function assertConfigured(res){
  const missing = [];
  if(!GITHUB_OWNER) missing.push("GITHUB_OWNER");
  if(!GITHUB_REPO) missing.push("GITHUB_REPO");
  if(!GITHUB_TOKEN) missing.push("GITHUB_TOKEN");
  if(!ADMIN_PASSCODE) missing.push("ADMIN_PASSCODE");
  if(missing.length){
    res.status(500).json({ error: `Server is missing required environment variables: ${missing.join(", ")}` });
    return false;
  }
  return true;
}

const GH_API = () => `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_DATA_PATH}`;
const GH_HEADERS = () => ({
  Authorization: `Bearer ${GITHUB_TOKEN}`,
  "User-Agent": "broadway-command-center",
  Accept: "application/vnd.github+json"
});

async function ghGetLinks(){
  const res = await fetch(`${GH_API()}?ref=${GITHUB_BRANCH}`, { headers: GH_HEADERS() });
  if(res.status === 404){
    // links.json doesn't exist in the repo yet — serve defaults, no sha yet.
    return { sha: null, links: DEFAULT_LINKS };
  }
  if(!res.ok){
    const body = await res.text();
    throw new Error(`GitHub read failed (${res.status}): ${body}`);
  }
  const data = await res.json();
  const content = Buffer.from(data.content, "base64").toString("utf-8");
  let links;
  try{ links = JSON.parse(content); }
  catch(e){ throw new Error("links.json in the repo is not valid JSON."); }
  if(!Array.isArray(links)) throw new Error("links.json in the repo is not a JSON array.");
  return { sha: data.sha, links };
}

async function ghPutLinks(links, sha, message){
  const content = Buffer.from(JSON.stringify(links, null, 2)).toString("base64");
  const body = { message, content, branch: GITHUB_BRANCH };
  if(sha) body.sha = sha;
  const res = await fetch(GH_API(), {
    method: "PUT",
    headers: { ...GH_HEADERS(), "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if(!res.ok){
    const errBody = await res.text();
    throw new Error(`GitHub write failed (${res.status}): ${errBody}`);
  }
  return res.json();
}

function checkPasscode(req, res){
  const supplied = req.header("x-admin-passcode");
  if(!supplied || supplied !== ADMIN_PASSCODE){
    res.status(401).json({ error: "Incorrect admin passcode." });
    return false;
  }
  return true;
}

function slugify(title, existing){
  let base = title.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  if(!base) base = `link-${Date.now()}`;
  let id = base, n = 2;
  while(existing.some(l => l.id === id)) id = `${base}-${n++}`;
  return id;
}

function validateUrl(url){
  try{ new URL(url); return true; }
  catch(e){ return false; }
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ---- Read the current link list (public, no auth needed) ----
app.get("/api/links", async (req, res) => {
  if(!assertConfigured(res)) return;
  try{
    const { links } = await ghGetLinks();
    res.json({ links });
  }catch(e){
    res.status(502).json({ error: e.message });
  }
});

// ---- Verify a passcode without making any changes ----
app.post("/api/admin/verify", (req, res) => {
  if(!ADMIN_PASSCODE) return res.status(500).json({ ok:false, error:"ADMIN_PASSCODE is not set on the server." });
  const { passcode } = req.body || {};
  if(passcode && passcode === ADMIN_PASSCODE) return res.json({ ok: true });
  return res.status(401).json({ ok: false });
});

// ---- Add a link ----
app.post("/api/links", async (req, res) => {
  if(!assertConfigured(res)) return;
  if(!checkPasscode(req, res)) return;
  try{
    const { title, url, description, color } = req.body || {};
    if(!title || !url) return res.status(400).json({ error: "Name and link are both required." });
    if(!validateUrl(url)) return res.status(400).json({ error: "That link isn't a valid URL. Include https://" });

    const { links, sha } = await ghGetLinks();
    const id = slugify(title, links);
    links.push({ id, title, url, description: description || "", color: color || "amber", locked: false });
    await ghPutLinks(links, sha, `Add dashboard link: ${title}`);
    res.json({ links });
  }catch(e){
    res.status(502).json({ error: e.message });
  }
});

// ---- Edit a link ----
app.put("/api/links/:id", async (req, res) => {
  if(!assertConfigured(res)) return;
  if(!checkPasscode(req, res)) return;
  try{
    const { title, url, description, color } = req.body || {};
    if(url && !validateUrl(url)) return res.status(400).json({ error: "That link isn't a valid URL. Include https://" });

    const { links, sha } = await ghGetLinks();
    const idx = links.findIndex(l => l.id === req.params.id);
    if(idx === -1) return res.status(404).json({ error: "That link no longer exists — someone may have deleted it." });

    links[idx] = {
      ...links[idx],
      ...(title ? { title } : {}),
      ...(url ? { url } : {}),
      description: description ?? links[idx].description,
      color: color || links[idx].color
    };
    await ghPutLinks(links, sha, `Update dashboard link: ${links[idx].title}`);
    res.json({ links });
  }catch(e){
    res.status(502).json({ error: e.message });
  }
});

// ---- Delete a link ----
app.delete("/api/links/:id", async (req, res) => {
  if(!assertConfigured(res)) return;
  if(!checkPasscode(req, res)) return;
  try{
    const { links, sha } = await ghGetLinks();
    const target = links.find(l => l.id === req.params.id);
    if(!target) return res.status(404).json({ error: "That link no longer exists." });
    if(target.locked) return res.status(403).json({ error: "This is a core dashboard link and can't be deleted (only edited)." });

    const next = links.filter(l => l.id !== req.params.id);
    await ghPutLinks(next, sha, `Delete dashboard link: ${target.title}`);
    res.json({ links: next });
  }catch(e){
    res.status(502).json({ error: e.message });
  }
});

// ---- Replace the whole list (used by Import / Restore defaults) ----
app.put("/api/links", async (req, res) => {
  if(!assertConfigured(res)) return;
  if(!checkPasscode(req, res)) return;
  try{
    const { links: incoming } = req.body || {};
    if(!Array.isArray(incoming)) return res.status(400).json({ error: "Expected a JSON array of links." });
    for(const l of incoming){
      if(!l.title || !l.url || !validateUrl(l.url)){
        return res.status(400).json({ error: `Invalid entry for "${l.title || "(untitled)"}" — needs a title and a valid URL.` });
      }
    }
    const { sha } = await ghGetLinks();
    await ghPutLinks(incoming, sha, "Replace dashboard link list");
    res.json({ links: incoming });
  }catch(e){
    res.status(502).json({ error: e.message });
  }
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    configured: Boolean(GITHUB_OWNER && GITHUB_REPO && GITHUB_TOKEN && ADMIN_PASSCODE)
  });
});

// SPA-style fallback for anything else
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Broadway Command Center listening on port ${PORT}`);
});
