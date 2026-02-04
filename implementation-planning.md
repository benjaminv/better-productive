# Productive.io Task Search System

> **Purpose**: Build a searchable task database that solves Productive.io's critical UX flaws—ticket numbers not in URLs, filter parameters breaking markdown links, and no native search by ticket number.

---

## Table of Contents

1. [Problem Statement & Requirements](#problem-statement--requirements)
2. [Solution Architecture](#solution-architecture)
   - [Jira-style URL Feature](#jira-style-url-feature)
3. [Quick Fix: Bookmarklet](#quick-fix-bookmarklet)
4. [Long-term Solution: Cloudflare Worker](#long-term-solution-cloudflare-worker)
5. [Setup Instructions](#setup-instructions)
6. [Implementation Details](#implementation-details)
7. [Alternative Approaches](#alternative-approaches)
8. [Cost Breakdown](#cost-breakdown)
9. [Implementation Checklist](#implementation-checklist)
10. [Testing & Validation](#testing--validation)
11. [Troubleshooting](#troubleshooting)
12. [Future Enhancements](#future-enhancements)

---

## Problem Statement & Requirements

### The Problem

Productive.io's task management has critical UX flaws:

| Issue | Impact |
|-------|--------|
| Ticket numbers (`#25`, `#204`) not in task URL | Impossible to find tasks by ticket number |
| Filter parameters make URLs long | Breaks when copying to markdown editors |
| No built-in search by ticket number | Workflow friction when referencing tickets |
| No Jira-style browsable URLs | Can't type `PROJ-123` in browser to navigate directly |

> [!NOTE]
> **Jira Comparison**: Jira URLs like `https://werd.atlassian.net/browse/PRIM-242` are developer-friendly—you can type them directly in the browser. We want the same: `https://productiver.io/browse/PRIM-242` → redirects to Productive.io task.

### Functional Requirements

| Requirement | Description |
|-------------|-------------|
| **Data Collection** | Automatically fetch all tasks from Productive.io API every hour |
| **Data Storage** | Store task metadata: ticket number, title, clean URL, status, assignee, project, due date, timestamps |
| **Search Interface** | Web-based search by ticket number (exact), title (partial), status, assignee, project |
| **Jira-style URLs** | `/browse/PRIM-242` redirects to the actual Productive.io task URL |
| **Project Prefixes** | Auto-generate unique prefixes from project names (e.g., "Prime100 Support" → `PRIM`) |
| **Fuzzy Search** | Typing "prim 242" matches `PRIM-242` |
| **Copy Functionality** | One-click copy as markdown: `[PRIM-242 Title](url)` |
| **Auto-sync** | Update database hourly via cron |
| **Manual Trigger** | Ability to manually trigger refresh |

### Technical Requirements

- Authentication via Productive.io API token
- Pagination support for large task lists
- CORS support for browser access
- Fast search response (<500ms)
- Minimal cost (use free tiers)

---

## Solution Architecture

### Technology Stack

| Component | Technology | Free Tier |
|-----------|------------|-----------|
| Compute | Cloudflare Workers | 100k requests/day |
| Storage | Cloudflare KV | 1GB |
| Data Source | Productive.io API v2 | — |
| Frontend | Vanilla JavaScript | — |

### System Diagram

```
┌─────────────────┐
│  Productive.io  │
│      API        │
└────────┬────────┘
         │
         │ Fetch tasks (hourly cron)
         │
         ▼
┌─────────────────┐
│  Cloudflare     │
│    Worker       │
│  (Serverless)   │
└────────┬────────┘
         │
         │ Store/Retrieve
         │
         ▼
┌─────────────────┐
│  Cloudflare KV  │
│   (Database)    │
└────────┬────────┘
         │
         │ Search queries
         │
         ▼
┌─────────────────┐
│   Web Browser   │
│  (Search UI)    │
└─────────────────┘
```

### Jira-style URL Feature

The killer feature: type `https://productiver.io/browse/PRIM-242` in your browser → instant redirect to Productive.io task.

#### URL Format

```
https://productiver.io/browse/{PREFIX}-{NUMBER}

Examples:
  /browse/PRIM-242  →  https://app.productive.io/1476-dotcollective/tasks/task/15790991
  /browse/PRIM-25   →  https://app.productive.io/1476-dotcollective/tasks/task/12345678
  /browse/PRIMU-15  →  https://app.productive.io/1476-dotcollective/tasks/task/98765432
```

#### Project Prefix Generation Algorithm

Prefixes are derived from project names using alphabetic characters only:

```javascript
function generatePrefix(projectName, existingPrefixes, minLength = 4) {
  // Extract only alphabetic characters, uppercase
  const alpha = projectName.replace(/[^a-zA-Z]/g, '').toUpperCase();
  
  // Try increasing lengths until unique
  for (let len = minLength; len <= alpha.length; len++) {
    const prefix = alpha.substring(0, len);
    if (!existingPrefixes.has(prefix)) {
      return prefix;
    }
  }
  
  // Fallback: append number if still collision
  let i = 2;
  while (existingPrefixes.has(`${alpha.substring(0, minLength)}${i}`)) {
    i++;
  }
  return `${alpha.substring(0, minLength)}${i}`;
}
```

#### Prefix Examples

| Project Name | Extracted Alpha | Prefix | Notes |
|--------------|-----------------|--------|-------|
| Prime100 Support | PRIMESUPPORT | `PRIM` | First 4 chars |
| Prime100 US Support | PRIMEUSSUPPORT | `PRIMU` | 5 chars (collision with PRIM) |
| Website Redesign | WEBSITEREDESIGN | `WEBS` | First 4 chars |
| API Development | APIDEVELOPMENT | `APID` | First 4 chars |

#### URL Routing

```javascript
// Route: GET /browse/:ticketKey
// Example: /browse/PRIM-242

async function handleBrowse(request, env) {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/browse\/([A-Z]+)-(\d+)$/i);
  
  if (!match) {
    return new Response('Invalid ticket format. Use: /browse/PRIM-242', { status: 400 });
  }
  
  const [, prefix, number] = match;
  const ticketNumber = parseInt(number);
  
  // Load tasks and prefix map from KV
  const tasks = JSON.parse(await env.TASKS_KV.get('all_tasks') || '[]');
  const prefixMap = JSON.parse(await env.TASKS_KV.get('prefix_map') || '{}');
  
  // Find project ID for this prefix
  const projectId = Object.entries(prefixMap)
    .find(([id, p]) => p.toUpperCase() === prefix.toUpperCase())?.[0];
  
  if (!projectId) {
    return new Response(`Unknown project prefix: ${prefix}`, { status: 404 });
  }
  
  // Find task by project + ticket number
  const task = tasks.find(t => 
    t.projectId === projectId && t.ticketNumber === ticketNumber
  );
  
  if (!task) {
    return new Response(`Ticket ${prefix}-${number} not found`, { status: 404 });
  }
  
  // Redirect to Productive.io
  return Response.redirect(task.url, 302);
}
```

#### Fuzzy Search Matching

Typing "prim 242" or "PRIM-242" or "prim242" all find the same task:

```javascript
function parseSearchQuery(query) {
  // Normalize: remove dashes, extra spaces, lowercase
  const normalized = query.toLowerCase().replace(/[-_]/g, ' ').trim();
  
  // Try to extract prefix and number
  const match = normalized.match(/^([a-z]+)\s*(\d+)$/);
  
  if (match) {
    return { prefix: match[1].toUpperCase(), number: parseInt(match[2]) };
  }
  
  return { text: normalized };
}

function searchTasks(tasks, prefixMap, query) {
  const parsed = parseSearchQuery(query);
  
  if (parsed.prefix && parsed.number) {
    // Jira-style search: "PRIM 242" or "prim-242"
    const projectId = Object.entries(prefixMap)
      .find(([id, p]) => p.toUpperCase() === parsed.prefix)?.[0];
    
    if (projectId) {
      return tasks.filter(t => 
        t.projectId === projectId && t.ticketNumber === parsed.number
      );
    }
  }
  
  // Fallback to fuzzy text search
  const q = parsed.text || query.toLowerCase();
  return tasks.filter(task =>
    task.ticketNumber.toString().includes(q) ||
    task.title.toLowerCase().includes(q) ||
    task.projectPrefix?.toLowerCase().includes(q) ||
    task.status.toLowerCase().includes(q) ||
    task.assignee.toLowerCase().includes(q) ||
    task.project.toLowerCase().includes(q)
  );
}
```

#### Data Structure Updates

Each task now includes the project prefix:

```javascript
{
  id: "15790991",
  ticketNumber: 242,
  ticketKey: "PRIM-242",        // NEW: Jira-style key
  projectPrefix: "PRIM",        // NEW: Project prefix
  projectId: "12345",           // NEW: For prefix lookup
  title: "Add Export All functionality for Orders",
  url: "https://app.productive.io/1476-dotcollective/tasks/task/15790991",
  // ... other fields
}
```

KV Storage additions:

| Key | Value | Purpose |
|-----|-------|---------|
| `prefix_map` | `{"12345": "PRIM", "67890": "WEBS"}` | Project ID → Prefix mapping |
| `prefix_index` | `{"PRIM": "12345", "WEBS": "67890"}` | Reverse lookup: Prefix → Project ID |

---

## Quick Fix: Bookmarklet

> [!TIP]
> Use this immediately while building the permanent solution.

### What It Does

✅ Adds ticket numbers to task titles (`#25`, `#204`, etc.)  
✅ Removes `?filter=...` from all task links  
✅ Cleans current page URL  
✅ Removes HTML elements inside links (only clean text remains)  
✅ Can be run multiple times—only updates what needs updating  
✅ Copies cleanly as markdown: `[#25 Product Enquiry form](https://app.productive.io/...)`

### Readable Version

```javascript
(function() {
  console.log('Adding ticket numbers to task titles...');
  
  let updated = 0;
  let skipped = 0;
  
  const taskLinks = document.querySelectorAll('a.data-table-cell__task');
  
  taskLinks.forEach(taskLink => {
    const titleDiv = taskLink.querySelector('.min-char-break');
    if (!titleDiv) return;
    
    const currentTitle = titleDiv.textContent.trim();
    
    // Check if already updated
    if (currentTitle.match(/^#\d+\s/)) {
      skipped++;
      return;
    }
    
    let row = taskLink.closest('div[class*="_list-layout-item-frame"]') ||
              taskLink.closest('div[class*="list-item"]');
    
    if (!row) return;
    
    const stringCells = row.querySelectorAll('.data-table-cell[render-type="string"]');
    let taskNumber = null;
    
    stringCells.forEach(cell => {
      const wrapper = cell.querySelector('.data-table-cell__oneliner-wrapper');
      if (wrapper) {
        const text = wrapper.textContent.trim();
        if (/^\d+$/.test(text) && !taskNumber) {
          taskNumber = text;
        }
      }
    });
    
    if (taskNumber) {
      const newTitle = `#${taskNumber} ${currentTitle}`;
      const href = taskLink.href.includes('?filter=') 
        ? taskLink.href.split('?filter=')[0] 
        : taskLink.href;
      taskLink.innerHTML = '';
      taskLink.textContent = newTitle;
      taskLink.href = href;
      console.log(`✓ Updated: "${currentTitle}" -> "${newTitle}"`);
      updated++;
    }
  });
  
  // Remove filter parameter from current page URL
  if (window.location.href.includes('?filter=')) {
    const cleanUrl = window.location.href.split('?filter=')[0];
    window.history.replaceState({}, document.title, cleanUrl);
    console.log('🧹 Cleaned current page URL');
  }
  
  console.log(`\n✅ Done! Updated ${updated} task(s), skipped ${skipped} already updated.`);
})();
```

### Minified Bookmarklet

Save this as a bookmark URL:

```
javascript:(function(){console.log('Adding ticket numbers to task titles...');let updated=0;let skipped=0;const taskLinks=document.querySelectorAll('a.data-table-cell__task');taskLinks.forEach(taskLink=>{const titleDiv=taskLink.querySelector('.min-char-break');if(!titleDiv)return;const currentTitle=titleDiv.textContent.trim();if(currentTitle.match(/^#\d+\s/)){skipped++;return;}let row=taskLink.closest('div[class*="_list-layout-item-frame"]')||taskLink.closest('div[class*="list-item"]');if(!row)return;const stringCells=row.querySelectorAll('.data-table-cell[render-type="string"]');let taskNumber=null;stringCells.forEach(cell=>{const wrapper=cell.querySelector('.data-table-cell__oneliner-wrapper');if(wrapper){const text=wrapper.textContent.trim();if(/^\d+$/.test(text)&&!taskNumber){taskNumber=text;}}});if(taskNumber){const newTitle=`#${taskNumber} ${currentTitle}`;const href=taskLink.href.includes('?filter=')?taskLink.href.split('?filter=')[0]:taskLink.href;taskLink.innerHTML='';taskLink.textContent=newTitle;taskLink.href=href;console.log(`✓ Updated: "${currentTitle}" -> "${newTitle}"`);updated++;}});if(window.location.href.includes('?filter=')){const cleanUrl=window.location.href.split('?filter=')[0];window.history.replaceState({},document.title,cleanUrl);console.log('🧹 Cleaned current page URL');}console.log(`\n✅ Done! Updated ${updated} task(s), skipped ${skipped} already updated.`);})();
```

### How to Use

1. Create a new bookmark in your browser
2. Name it: **"Add Ticket #s"**
3. For the URL, paste the minified version above
4. On any Productive.io tasks page, click the bookmark
5. All task titles will be updated with `#number` prefix
6. Copy cleanly to markdown editors

---

## Long-term Solution: Cloudflare Worker

### File Structure

```
productive-search/
├── wrangler.toml          # Cloudflare configuration
├── src/
│   └── index.js           # Main worker code
└── README.md              # Setup instructions
```

### Configuration: `wrangler.toml`

```toml
name = "productive-search"
main = "src/index.js"
compatibility_date = "2024-01-01"

# KV namespace for storing tasks
[[kv_namespaces]]
binding = "TASKS_KV"
id = "YOUR_KV_ID_HERE"  # Generated during setup

# Cron trigger - runs every hour
[triggers]
crons = ["0 * * * *"]

# Environment variables
[vars]
PRODUCTIVE_ORG_ID = "1476"  # Your org ID from URL

# Secrets (use: wrangler secret put PRODUCTIVE_API_TOKEN)
# PRODUCTIVE_API_TOKEN = "your-token-here"
```

### Worker Entry Point: `src/index.js`

```javascript
export default {
  // Cron handler - runs every hour
  async scheduled(event, env, ctx) {
    await updateTaskDatabase(env);
  },
  
  // HTTP request handler
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // Routes:
    // GET /              → Search UI (HTML)
    // GET /browse/PRIM-X → Redirect to Productive.io task (Jira-style)
    // GET /api/search    → JSON search results
    // POST /update       → Manual database refresh
    // OPTIONS *          → CORS preflight
    
    // Handle /browse/PRIM-242 style URLs
    if (url.pathname.startsWith('/browse/')) {
      return handleBrowse(request, env);
    }
    
    switch (url.pathname) {
      case '/':
        return new Response(await renderSearchPage(env), {
          headers: { 'Content-Type': 'text/html' }
        });
      case '/api/search':
        return handleSearch(url, env);
      case '/update':
        return handleManualUpdate(env);
      default:
        return new Response('Not Found', { status: 404 });
    }
  }
};
```

---

## Setup Instructions

### Prerequisites

| Requirement | Details |
|-------------|---------|
| **Cloudflare Account** | Sign up at [cloudflare.com](https://cloudflare.com) (free tier) |
| **Productive.io API Token** | Settings → Integrations → API → Generate new token (Read only) |
| **Organization ID** | Found in your Productive URLs (e.g., `1476` from `1476-dotcollective`) |
| **Node.js** | v16 or higher |

### Step-by-Step Setup

```bash
# 1. Install Wrangler CLI globally
npm install -g wrangler

# 2. Login to Cloudflare
wrangler login
# Opens browser for OAuth authentication

# 3. Create new Worker project
npm create cloudflare@latest productive-search
cd productive-search

# 4. Create KV namespace
wrangler kv:namespace create TASKS_KV
# Copy the ID from output, paste into wrangler.toml

# 5. Add your API token as secret
wrangler secret put PRODUCTIVE_API_TOKEN
# Paste your token when prompted

# 6. Update wrangler.toml with your org ID
# Edit the PRODUCTIVE_ORG_ID value

# 7. Implement the code in src/index.js

# 8. Test locally
wrangler dev
# Opens http://localhost:8787

# 9. Test API connection
curl http://localhost:8787/update

# 10. Deploy to production
wrangler deploy
# Get your URL: https://productive-search.yourname.workers.dev
```

### Getting Your Credentials

#### API Token

1. Go to `https://app.productive.io/{org-id}/settings/integrations/api`
2. Click **"Generate new token"**
3. Name: `Task Search System`
4. Access: **Read only**
5. Copy token immediately (shown only once)

#### Organization ID

- Look at your Productive URL: `https://app.productive.io/1476-dotcollective/tasks`
- The number is: `1476`

---

## Implementation Details

### Productive.io API Reference

| Property | Value |
|----------|-------|
| Base URL | `https://api.productive.io/api/v2` |
| Documentation | [developer.productive.io](https://developer.productive.io) |
| Authentication | Bearer token in `Authorization` header |
| Required Header | `X-Organization-Id: {your-org-id}` |

#### Request Headers

```javascript
{
  'Authorization': `Bearer ${apiToken}`,
  'Content-Type': 'application/vnd.api+json',
  'X-Organization-Id': orgId
}
```

#### Fetching Tasks

```
GET /tasks
  ?filter[organization_id]=1476
  &page[number]=1
  &page[size]=200
  &include=assignee,project,workflow_status
```

#### Response Structure

```json
{
  "data": [{
    "id": "12345",
    "type": "tasks",
    "attributes": {
      "number": 25,
      "title": "Task title",
      "due_date": "2025-11-15",
      "workflow_status_name": "In Progress"
    },
    "relationships": {
      "assignee": { "data": { "id": "123", "type": "people" } },
      "project": { "data": { "id": "456", "type": "projects" } }
    }
  }],
  "included": [
    { "id": "123", "type": "people", "attributes": { "name": "John Doe" } },
    { "id": "456", "type": "projects", "attributes": { "name": "Project X" } }
  ],
  "links": {
    "next": "url-to-next-page"
  }
}
```

### Core Functions

#### A. `updateTaskDatabase(env)` — API Sync

```javascript
async function updateTaskDatabase(env) {
  const { PRODUCTIVE_API_TOKEN, PRODUCTIVE_ORG_ID } = env;
  const baseUrl = 'https://api.productive.io/api/v2/tasks';
  
  let page = 1;
  let allTasks = [];
  let hasMore = true;
  
  while (hasMore && page <= 100) {
    const url = `${baseUrl}?filter[organization_id]=${PRODUCTIVE_ORG_ID}` +
                `&page[number]=${page}&page[size]=200` +
                `&include=assignee,project,workflow_status`;
    
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${PRODUCTIVE_API_TOKEN}`,
        'Content-Type': 'application/vnd.api+json',
        'X-Organization-Id': PRODUCTIVE_ORG_ID
      }
    });
    
    const data = await response.json();
    
    // Build lookup maps from included
    const peopleMap = {};
    const projectMap = {};
    const statusMap = {};
    
    (data.included || []).forEach(item => {
      if (item.type === 'people') peopleMap[item.id] = item.attributes.name;
      if (item.type === 'projects') projectMap[item.id] = item.attributes.name;
      if (item.type === 'workflow_statuses') statusMap[item.id] = item.attributes.name;
    });
    
    // Process tasks
    data.data.forEach(task => {
      const assigneeId = task.relationships?.assignee?.data?.id;
      const projectId = task.relationships?.project?.data?.id;
      
      allTasks.push({
        id: task.id,
        ticketNumber: task.attributes.number,
        title: task.attributes.title,
        url: `https://app.productive.io/${PRODUCTIVE_ORG_ID}-dotcollective/tasks/task/${task.id}`,
        status: task.attributes.workflow_status_name || 'Unknown',
        assignee: peopleMap[assigneeId] || 'Unassigned',
        project: projectMap[projectId] || 'No Project',
        dueDate: task.attributes.due_date,
        updatedAt: task.attributes.updated_at
      });
    });
    
    hasMore = !!data.links?.next;
    page++;
  }
  
  // Store in KV
  await env.TASKS_KV.put('all_tasks', JSON.stringify(allTasks));
  await env.TASKS_KV.put('last_updated', new Date().toISOString());
  await env.TASKS_KV.put('task_count', allTasks.length.toString());
  
  return allTasks;
}
```

#### B. `searchTasks(tasks, query)` — Search Logic

```javascript
function searchTasks(tasks, query) {
  if (!query) return tasks;
  
  // Exact ticket number match
  if (/^\d+$/.test(query)) {
    return tasks.filter(t => t.ticketNumber === parseInt(query));
  }
  
  // Fuzzy search across all fields
  const q = query.toLowerCase();
  return tasks.filter(task =>
    task.ticketNumber.toString().includes(q) ||
    task.title.toLowerCase().includes(q) ||
    task.status.toLowerCase().includes(q) ||
    task.assignee.toLowerCase().includes(q) ||
    task.project.toLowerCase().includes(q)
  );
}
```

#### C. `renderSearchPage()` — HTML UI

Key features to implement:
- Search input with debounce (500ms)
- Stats bar: `"{X} of {Y} tasks • Last updated: {time}"`
- Task cards with: ticket number, title, status badge, metadata
- **Copy MD** button per task (copies `[#X Title](url)`)
- Manual **Update Now** button
- Responsive design
- Keyboard shortcuts (`Cmd+K` to focus search)

#### D. Helper Functions

```javascript
// Prevent XSS
function escapeHtml(str) {
  return str.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// Client-side: copy markdown to clipboard
function copyMarkdown(ticketNumber, title, url) {
  const markdown = `[#${ticketNumber} ${title}](${url})`;
  navigator.clipboard.writeText(markdown);
}

// Client-side: trigger manual refresh
async function updateNow() {
  await fetch('/update', { method: 'POST' });
  location.reload();
}
```

---

## Alternative Approaches

### Option A: Browser Extension

| Pros | Cons |
|------|------|
| No server needed | Only syncs when browser running |
| Simpler setup | Limited storage (10MB) |
| Works offline | Not accessible from other devices |

**Structure:**
```
manifest.json:
  - permissions: ["storage", "alarms"]
  - background service worker
  - popup UI

background.js:
  - chrome.alarms.create('sync', { periodInMinutes: 60 })
  - On alarm: fetch from API, store in chrome.storage.local

popup.html/js:
  - Search UI
  - Read from chrome.storage.local
```

### Option B: Hybrid (Browser → Worker)

Bookmarklet collects tasks from DOM and sends to worker:

```javascript
const tasks = collectTasksFromDOM();
fetch('https://your-worker.workers.dev/collect', {
  method: 'POST',
  body: JSON.stringify(tasks)
});
```

| Pros | Cons |
|------|------|
| No API token in worker | Requires manual browsing |
| Crowdsourced updates | Less reliable |

---

## Cost Breakdown

### Cloudflare Workers (Free Tier)

| Resource | Free Tier | Your Usage | Cost |
|----------|-----------|------------|------|
| Worker Requests | 100k/day | ~730/day | **$0** |
| KV Storage | 1GB | ~1-5MB | **$0** |
| KV Reads | 100k/day | ~100-500/day | **$0** |
| KV Writes | 1k/day | ~24/day | **$0** |
| **Total** | | | **$0/month** |

### Productive.io API

- No additional cost
- Rate limits: ~100-200 requests/minute
- Read-only token (safest)

---

## Implementation Checklist

### Phase 1: Setup (30 mins)

- [ ] Create Cloudflare account
- [ ] Install Wrangler CLI
- [ ] Generate Productive.io API token (read-only)
- [ ] Note Organization ID
- [ ] Create Worker project
- [ ] Create KV namespace
- [ ] Configure `wrangler.toml`

### Phase 2: Core Implementation (2-3 hours)

- [ ] Implement `updateTaskDatabase()` with API pagination
- [ ] Handle API response parsing
- [ ] Build relationship lookup maps (people, projects, statuses)
- [ ] Implement project prefix generation algorithm
- [ ] Store `prefix_map` and `prefix_index` in KV
- [ ] Add `ticketKey` and `projectPrefix` to task objects
- [ ] Test API connection locally
- [ ] Implement `searchTasks()` with fuzzy matching
- [ ] Test search logic (including "prim 242" style queries)

### Phase 3: Jira-style URLs (1 hour)

- [ ] Implement `/browse/:ticketKey` route handler
- [ ] Add 302 redirect to Productive.io task URL
- [ ] Handle invalid/unknown ticket keys gracefully
- [ ] Test URL redirects locally

### Phase 4: UI & Deployment (1-2 hours)

- [ ] Implement `renderSearchPage()` HTML
- [ ] Display tasks with Jira-style keys (e.g., `PRIM-242`)
- [ ] Add CSS styling
- [ ] Add JavaScript for search/copy functionality
- [ ] Copy markdown with Jira-style key: `[PRIM-242 Title](url)`
- [ ] Test locally with `wrangler dev`
- [ ] Deploy to production
- [ ] Test deployed version
- [ ] Set up cron trigger
- [ ] Verify hourly sync works

### Phase 5: Enhancements (Optional)

- [ ] Add filters (by status, assignee, project)
- [ ] Add sorting options
- [ ] Add pagination for large result sets
- [ ] Add keyboard shortcuts
- [ ] Add dark mode
- [ ] Add export to CSV/JSON
- [ ] Add webhook for real-time updates

---

## Testing & Validation

### Local Testing

```bash
# Start local dev server
wrangler dev

# Test update endpoint
curl http://localhost:8787/update

# Test search by ticket number
curl "http://localhost:8787/api/search?q=25"

# Test fuzzy search (Jira-style)
curl "http://localhost:8787/api/search?q=prim%20242"

# Test Jira-style URL redirect
curl -I http://localhost:8787/browse/PRIM-242
# Should return 302 redirect to Productive.io

# Open UI
open http://localhost:8787/
```

### Production Testing

```bash
# Deploy
wrangler deploy

# Test endpoints
curl https://productive-search.yourname.workers.dev/update
curl "https://productive-search.yourname.workers.dev/api/search?q=sprint"

# Test Jira-style browse (should redirect)
open https://productive-search.yourname.workers.dev/browse/PRIM-242

# Open search UI
open https://productive-search.yourname.workers.dev/
```

### Validation Checklist

- [ ] API authentication works
- [ ] All tasks are fetched (check count)
- [ ] Pagination works correctly
- [ ] Project prefixes generated correctly (check `prefix_map`)
- [ ] Related data (assignee, project) correctly resolved
- [ ] Search by ticket number works (`242`)
- [ ] Search by Jira-style key works (`PRIM-242`, `prim 242`)
- [ ] `/browse/PRIM-242` redirects to correct Productive.io task
- [ ] Unknown tickets return 404 with helpful message
- [ ] Copy markdown works (includes Jira-style key)
- [ ] Manual update works
- [ ] Cron trigger runs hourly
- [ ] UI is responsive
- [ ] No CORS errors

---

## Troubleshooting

### Common Issues

| Issue | Solution |
|-------|----------|
| **API returns 401 Unauthorized** | Check API token is correct; verify not revoked; ensure `X-Organization-Id` matches |
| **No tasks returned** | Check `filter[organization_id]` matches; verify token has read access; check pagination (`links.next`) |
| **Related data not showing** | Ensure `?include=assignee,project,workflow_status` in API call; check `included` array parsing |
| **Cron not triggering** | Check `[triggers]` crons in config; cron only works in production; check CF dashboard |
| **KV not updating** | Verify KV namespace binding; check ID matches; test with `wrangler kv:key get` |
| **`/browse/PRIM-242` returns 404** | Verify prefix exists in `prefix_map`; check task has that ticket number; ensure API sync completed |
| **Prefix collision** | Algorithm auto-expands to 5+ chars; check `prefix_map` for existing prefixes |
| **Fuzzy search not matching** | Ensure query format is correct (`prim 242` or `PRIM-242`); check prefix is stored in task objects |

---

## Custom Domain Setup

To use a custom domain like `productiver.io` instead of `productive-search.yourname.workers.dev`:

### Option 1: Cloudflare-managed Domain

```bash
# In Cloudflare Dashboard:
# Workers & Pages → Your Worker → Custom Domains → Add Custom Domain
# Enter: productiver.io or tasks.yourdomain.com
```

### Option 2: Route Mapping (if domain already in Cloudflare)

Add to `wrangler.toml`:

```toml
routes = [
  { pattern = "productiver.io/*", zone_name = "productiver.io" }
]
```

> [!TIP]
> The Jira-style URL `https://productiver.io/browse/PRIM-242` only works once you have a custom domain configured.

---

## Future Enhancements

### Phase 1 (Post-MVP)
- Filters dropdown (status, assignee, project)
- Sort by: ticket number, date, title
- Recent searches history
- Prefix management UI (view/edit prefix mappings)

### Phase 2
- Webhook integration for real-time updates
- Export search results to CSV
- Save favorite searches  
- Dark mode toggle
- Mobile app (PWA)

### Phase 3
- Cloudflare D1 (SQLite) for better queries
- Full-text search with ranking
- Task activity history
- Analytics dashboard
- Multi-org support

---

## Security Considerations

| Concern | Mitigation |
|---------|------------|
| API Token Storage | Store in Wrangler secrets (encrypted) |
| Access Level | Use read-only token (can't modify data) |
| CORS | Currently `*` — restrict in production if needed |
| Rate Limiting | Add if public-facing |
| Input Sanitization | Escape all user input in HTML |

---

## Summary

| Solution | Status | Time to Implement |
|----------|--------|-------------------|
| **Bookmarklet** | ✅ Ready to use | Immediate |
| **Cloudflare Worker** | 📋 Planned | 4-6 hours |

### Benefits of Worker Solution

✅ **Jira-style URLs** — type `/browse/PRIM-242` → instant redirect  
✅ **Fuzzy search** — "prim 242" finds `PRIM-242`  
✅ **Always up-to-date** task database  
✅ **Fast search** by ticket number or project key  
✅ **Accessible from anywhere**  
✅ **$0/month cost**  
✅ **One-click markdown copy** with Jira-style keys

### Next Steps

1. Use bookmarklet for immediate needs
2. Generate Productive.io API token
3. Set up Cloudflare Worker using this guide
4. Deploy and enjoy permanent searchable task database
5. (Optional) Configure custom domain for `productiver.io/browse/PRIM-242`

---

> 🎯 *Built to solve Productive.io's questionable design decision of not including ticket numbers in URLs*