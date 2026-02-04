// Productive.io Task Search with Jira-style URLs
// A Cloudflare Worker that provides searchable task database with /browse/PRIM-242 redirects

export default {
  // Cron handler - runs every hour to sync tasks
  async scheduled(event, env, ctx) {
    console.log('Cron triggered: Updating task database...');
    try {
      const result = await updateTaskDatabase(env);
      console.log(`Sync complete: ${result.taskCount} tasks, ${result.projectCount} projects`);
    } catch (error) {
      console.error('Sync failed:', error);
    }
  },

  // HTTP request handler
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return handleCors();
    }

    try {
      // Routes:
      // GET /              → Search UI (HTML)
      // GET /browse/PRIM-X → Redirect to Productive.io task (Jira-style)
      // GET /api/search    → JSON search results
      // GET /api/prefixes  → List all project prefixes
      // GET /api/filters   → List all available filters
      // POST /update       → Manual database refresh

      // Handle /browse/PRIM-242 style URLs
      if (url.pathname.startsWith('/browse/')) {
        return handleBrowse(url, env);
      }

      switch (url.pathname) {
        case '/':
          return new Response(await renderSearchPage(env), {
            headers: { 'Content-Type': 'text/html' }
          });
        case '/api/search':
          return handleSearch(url, env);
        case '/api/prefixes':
          return handlePrefixes(env);
        case '/api/filters':
          return handleFilters(env);
        case '/update':
          return handleManualUpdate(request, env);
        default:
          return new Response('Not Found', { status: 404 });
      }
    } catch (error) {
      console.error('Request error:', error);
      return new Response(`Error: ${error.message}`, { status: 500 });
    }
  }
};

// =============================================================================
// CORS Helper
// =============================================================================

function handleCors() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    }
  });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };
}

// =============================================================================
// Project Prefix Generation
// =============================================================================

function generatePrefix(projectName, existingPrefixes, minLength = 4) {
  // Extract only alphabetic characters, uppercase
  const alpha = projectName.replace(/[^a-zA-Z]/g, '').toUpperCase();

  if (alpha.length === 0) {
    // Fallback for projects with no letters
    return `PROJ${existingPrefixes.size + 1}`;
  }

  // Try increasing lengths until unique
  for (let len = minLength; len <= alpha.length; len++) {
    const prefix = alpha.substring(0, len);
    if (!existingPrefixes.has(prefix)) {
      return prefix;
    }
  }

  // Fallback: append number if still collision
  let i = 2;
  const basePrefix = alpha.substring(0, minLength);
  while (existingPrefixes.has(`${basePrefix}${i}`)) {
    i++;
  }
  return `${basePrefix}${i}`;
}

function generateAllPrefixes(projects) {
  const prefixMap = {};      // projectId -> prefix
  const prefixIndex = {};    // prefix -> projectId
  const existingPrefixes = new Set();

  // Sort projects by name to ensure consistent prefix generation
  const sortedProjects = [...projects].sort((a, b) => a.name.localeCompare(b.name));

  for (const project of sortedProjects) {
    const prefix = generatePrefix(project.name, existingPrefixes);
    prefixMap[project.id] = prefix;
    prefixIndex[prefix] = project.id;
    existingPrefixes.add(prefix);
  }

  return { prefixMap, prefixIndex };
}

// =============================================================================
// API Sync - Fetch all tasks from Productive.io
// =============================================================================

// Get the current user's person ID from API or cache
async function getPersonId(env) {
  const apiToken = env.PRODUCTIVE_API_TOKEN;
  const orgId = env.PRODUCTIVE_ORG_ID;
  
  // Check if we have it cached in KV
  const cached = await env.TASKS_KV.get('current_person_id');
  if (cached) return cached;
  
  // Check if hardcoded in env (fallback)
  if (env.PRODUCTIVE_PERSON_ID) {
    await env.TASKS_KV.put('current_person_id', env.PRODUCTIVE_PERSON_ID);
    return env.PRODUCTIVE_PERSON_ID;
  }
  
  // Fetch from API using organization_memberships endpoint
  const response = await fetch(
    'https://api.productive.io/api/v2/organization_memberships?include=person',
    {
      headers: {
        'X-Auth-Token': apiToken,
        'Content-Type': 'application/vnd.api+json',
        'X-Organization-Id': orgId
      }
    }
  );
  
  if (!response.ok) {
    throw new Error('Failed to fetch person ID from API');
  }
  
  const data = await response.json();
  const person = data.included?.find(item => item.type === 'people');
  
  if (!person) {
    throw new Error('Could not determine current user from API');
  }
  
  const personId = person.id;
  const personName = person.attributes.name || person.attributes.email;
  
  // Cache it
  await env.TASKS_KV.put('current_person_id', personId);
  await env.TASKS_KV.put('current_person_name', personName);
  
  console.log(`Detected person ID: ${personId} (${personName})`);
  return personId;
}

async function updateTaskDatabase(env) {
  const apiToken = env.PRODUCTIVE_API_TOKEN;
  const orgId = env.PRODUCTIVE_ORG_ID;
  const orgSlug = env.PRODUCTIVE_ORG_SLUG || 'dotcollective';
  
  // Get person ID from cache or API (no longer needs env var)
  const personId = await getPersonId(env);

  if (!apiToken) {
    throw new Error('PRODUCTIVE_API_TOKEN not configured');
  }

  const baseUrl = 'https://api.productive.io/api/v2/tasks';
  const headers = {
    'X-Auth-Token': apiToken,
    'Content-Type': 'application/vnd.api+json',
    'X-Organization-Id': orgId
  };

  // Load existing tasks to preserve deleted ones
  const existingTasksJson = await env.TASKS_KV.get('all_tasks');
  const existingTasks = existingTasksJson ? JSON.parse(existingTasksJson) : [];
  const existingTasksMap = new Map(existingTasks.map(t => [t.id, t]));

  let taskMap = new Map();  // Use map to dedupe by task ID
  let allProjects = new Map();
  let allStatuses = new Set();
  let allAssignees = new Map();

  // Helper to fetch paginated tasks with a specific filter
  async function fetchTasksWithFilter(filterParam, filterValue) {
    let page = 1;
    let hasMore = true;
    
    while (hasMore && page <= 25) {  // 25 pages per filter type = 50 total max
      const url = `${baseUrl}?page[number]=${page}&page[size]=200` +
        `&include=assignee,project,workflow_status` +
        `&filter[${filterParam}]=${filterValue}` +
        `&sort=-id`;             // Fetch newest tasks first

      console.log(`Fetching ${filterParam}=${filterValue} page ${page}...`);
      const response = await fetch(url, { headers });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API error ${response.status}: ${errorText}`);
      }

      const data = await response.json();

      // Build lookup maps from included data
      const peopleMap = {};
      const projectMap = {};
      const statusMap = {};

      (data.included || []).forEach(item => {
        if (item.type === 'people') {
          const name = item.attributes.name || item.attributes.email || 'Unknown';
          peopleMap[item.id] = name;
          allAssignees.set(item.id, name);
        }
        if (item.type === 'projects') {
          projectMap[item.id] = item.attributes.name;
          allProjects.set(item.id, { id: item.id, name: item.attributes.name });
        }
        if (item.type === 'workflow_statuses') {
          statusMap[item.id] = item.attributes.name;
        }
      });

      // Process tasks
      for (const task of data.data) {
        if (taskMap.has(task.id)) continue;  // Skip duplicates

        const assigneeId = task.relationships?.assignee?.data?.id;
        const projectId = task.relationships?.project?.data?.id;
        const statusId = task.relationships?.workflow_status?.data?.id;
        const status = statusMap[statusId] || task.attributes.workflow_status_name || 'Unknown';
        
        allStatuses.add(status);

        taskMap.set(task.id, {
          id: task.id,
          ticketNumber: task.attributes.number,
          title: task.attributes.title,
          projectId: projectId,
          project: projectMap[projectId] || 'No Project',
          status: status,
          assigneeId: assigneeId || null,
          assignee: peopleMap[assigneeId] || 'Unassigned',
          dueDate: task.attributes.due_date,
          createdAt: task.attributes.created_at,
          updatedAt: task.attributes.updated_at,
          url: `https://app.productive.io/${orgId}-${orgSlug}/tasks/task/${task.id}`,
          _deleted: false
        });
      }

      hasMore = !!data.links?.next;
      page++;
    }
  }

  // Fetch BOTH subscribed AND assigned tasks
  if (personId) {
    await fetchTasksWithFilter('subscriber_id', personId);
    await fetchTasksWithFilter('assignee_id', personId);
  }

  // Preserve tasks from previous sync that are no longer in API (mark as deleted)
  for (const [taskId, existingTask] of existingTasksMap) {
    if (!taskMap.has(taskId)) {
      // Task was in DB but not in API - mark as unknown but keep it
      taskMap.set(taskId, {
        ...existingTask,
        status: existingTask._deleted ? existingTask.status : 'Unknown',
        _deleted: true
      });
      allStatuses.add('Unknown');
    }
  }

  const allTasks = [...taskMap.values()].sort((a, b) => b.id - a.id);

  // Generate prefixes for all projects
  const { prefixMap, prefixIndex } = generateAllPrefixes([...allProjects.values()]);

  // Add ticketKey and projectPrefix to each task
  for (const task of allTasks) {
    const prefix = prefixMap[task.projectId] || task.projectPrefix || 'UNKN';
    task.projectPrefix = prefix;
    task.ticketKey = `${prefix}-${task.ticketNumber}`;
  }

  // Store everything in KV
  await env.TASKS_KV.put('all_tasks', JSON.stringify(allTasks));
  await env.TASKS_KV.put('prefix_map', JSON.stringify(prefixMap));
  await env.TASKS_KV.put('prefix_index', JSON.stringify(prefixIndex));
  await env.TASKS_KV.put('last_updated', new Date().toISOString());
  await env.TASKS_KV.put('task_count', allTasks.length.toString());
  
  // Count assigned tasks for stats
  const assignedCount = allTasks.filter(t => t.assigneeId === personId && !t._deleted).length;
  await env.TASKS_KV.put('assigned_count', assignedCount.toString());
  
  // Store filter options for the UI
  await env.TASKS_KV.put('filter_statuses', JSON.stringify([...allStatuses].sort()));
  await env.TASKS_KV.put('filter_assignees', JSON.stringify(
    [...allAssignees.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
  ));
  
  // Store projects with names and prefixes for the project filter dropdown
  const projectsWithNames = [...allProjects.values()].map(p => ({
    id: p.id,
    name: p.name,
    prefix: prefixMap[p.id] || 'UNKN'
  })).sort((a, b) => a.name.localeCompare(b.name));
  await env.TASKS_KV.put('filter_projects', JSON.stringify(projectsWithNames));
  
  // Store current user's person ID for "assigned to me" filter
  await env.TASKS_KV.put('current_person_id', personId);

  const activeCount = allTasks.filter(t => !t._deleted).length;
  const deletedCount = allTasks.filter(t => t._deleted).length;

  return {
    taskCount: allTasks.length,
    assignedCount,
    activeCount,
    deletedCount,
    projectCount: allProjects.size,
    prefixes: prefixMap
  };
}

// =============================================================================
// Search Functions
// =============================================================================

function parseSearchQuery(query) {
  if (!query) return { text: '' };

  // Normalize: remove dashes, extra spaces
  const normalized = query.trim().toLowerCase().replace(/[-_]/g, ' ').replace(/\s+/g, ' ');

  // Try to extract prefix and number (e.g., "prim 242" or "prim242")
  const match = normalized.match(/^([a-z]+)\s*(\d+)$/);

  if (match) {
    return { prefix: match[1].toUpperCase(), number: parseInt(match[2]) };
  }

  // Check for just a number
  if (/^\d+$/.test(normalized)) {
    return { number: parseInt(normalized) };
  }

  return { text: normalized };
}

function searchTasks(tasks, prefixIndex, query) {
  if (!query || query.trim() === '') {
    // Return most recent tasks (sorted by ID desc)
    return tasks.sort((a, b) => b.id - a.id);
  }

  const parsed = parseSearchQuery(query);

  // Search by prefix + number (e.g., "PRIM 242")
  if (parsed.prefix && parsed.number !== undefined) {
    const projectId = prefixIndex[parsed.prefix];
    if (projectId) {
      const result = tasks.filter(t =>
        t.projectId === projectId && t.ticketNumber === parsed.number
      );
      if (result.length > 0) return result;
    }
    // If exact match not found, fall through to fuzzy search
  }

  // Search by just number
  if (parsed.number !== undefined && !parsed.prefix) {
    const exactMatch = tasks.filter(t => t.ticketNumber === parsed.number);
    if (exactMatch.length > 0) return exactMatch;
  }

  // Fuzzy text search
  const q = parsed.text || query.toLowerCase();
  return tasks.filter(task =>
    task.ticketNumber.toString().includes(q) ||
    task.ticketKey.toLowerCase().includes(q) ||
    task.title.toLowerCase().includes(q) ||
    task.status.toLowerCase().includes(q) ||
    task.assignee.toLowerCase().includes(q) ||
    task.project.toLowerCase().includes(q)
  ).sort((a, b) => b.id - a.id);
}

// =============================================================================
// Route Handlers
// =============================================================================

async function handleBrowse(url, env) {
  const match = url.pathname.match(/^\/browse\/([A-Z]+)-(\d+)$/i);

  if (!match) {
    return new Response(
      'Invalid ticket format. Use: /browse/PRIM-242',
      { status: 400, headers: { 'Content-Type': 'text/plain' } }
    );
  }

  const [, prefix, number] = match;
  const ticketNumber = number;  // Keep as string since API returns it as string

  // Load data from KV
  const [tasksJson, prefixIndexJson] = await Promise.all([
    env.TASKS_KV.get('all_tasks'),
    env.TASKS_KV.get('prefix_index')
  ]);

  if (!tasksJson) {
    return new Response(
      'Database not initialized. Please trigger /update first.',
      { status: 503, headers: { 'Content-Type': 'text/plain' } }
    );
  }

  const tasks = JSON.parse(tasksJson);
  const prefixIndex = JSON.parse(prefixIndexJson || '{}');

  // Find project ID for this prefix
  const projectId = prefixIndex[prefix.toUpperCase()];

  if (!projectId) {
    return new Response(
      `Unknown project prefix: ${prefix.toUpperCase()}. Available prefixes: ${Object.keys(prefixIndex).join(', ')}`,
      { status: 404, headers: { 'Content-Type': 'text/plain' } }
    );
  }

  // Find task by project + ticket number (compare as strings)
  const task = tasks.find(t =>
    t.projectId === projectId && String(t.ticketNumber) === String(ticketNumber)
  );

  if (!task) {
    return new Response(
      `Ticket ${prefix.toUpperCase()}-${number} not found in project.`,
      { status: 404, headers: { 'Content-Type': 'text/plain' } }
    );
  }

  // Redirect to Productive.io
  return Response.redirect(task.url, 302);
}

async function handleSearch(url, env) {
  const query = url.searchParams.get('q') || '';

  const [tasksJson, prefixIndexJson, lastUpdated] = await Promise.all([
    env.TASKS_KV.get('all_tasks'),
    env.TASKS_KV.get('prefix_index'),
    env.TASKS_KV.get('last_updated')
  ]);

  if (!tasksJson) {
    return new Response(JSON.stringify({
      error: 'Database not initialized',
      tasks: [],
      total: 0
    }), { headers: corsHeaders() });
  }

  const tasks = JSON.parse(tasksJson);
  const prefixIndex = JSON.parse(prefixIndexJson || '{}');
  const results = searchTasks(tasks, prefixIndex, query);

  return new Response(JSON.stringify({
    query,
    tasks: results,
    count: results.length,
    total: tasks.length,
    lastUpdated
  }), { headers: corsHeaders() });
}

async function handlePrefixes(env) {
  const [prefixMapJson, prefixIndexJson] = await Promise.all([
    env.TASKS_KV.get('prefix_map'),
    env.TASKS_KV.get('prefix_index')
  ]);

  return new Response(JSON.stringify({
    prefixMap: JSON.parse(prefixMapJson || '{}'),
    prefixIndex: JSON.parse(prefixIndexJson || '{}')
  }), { headers: corsHeaders() });
}

async function handleFilters(env) {
  const [projectsJson, statusesJson, assigneesJson, currentPersonId] = await Promise.all([
    env.TASKS_KV.get('filter_projects'),
    env.TASKS_KV.get('filter_statuses'),
    env.TASKS_KV.get('filter_assignees'),
    env.TASKS_KV.get('current_person_id')
  ]);

  return new Response(JSON.stringify({
    projects: JSON.parse(projectsJson || '[]'),
    statuses: JSON.parse(statusesJson || '[]'),
    assignees: JSON.parse(assigneesJson || '[]'),
    currentPersonId: currentPersonId || null
  }), { headers: corsHeaders() });
}

async function handleManualUpdate(request, env) {
  // Allow both GET and POST for manual updates
  try {
    const result = await updateTaskDatabase(env);
    return new Response(JSON.stringify({
      success: true,
      message: 'Database updated successfully',
      ...result
    }), { headers: corsHeaders() });
  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: corsHeaders()
    });
  }
}

// =============================================================================
// HTML UI
// =============================================================================

async function renderSearchPage(env) {
  const [lastUpdated, taskCount, assignedCount] = await Promise.all([
    env.TASKS_KV.get('last_updated'),
    env.TASKS_KV.get('task_count'),
    env.TASKS_KV.get('assigned_count')
  ]);

  const lastUpdatedDisplay = lastUpdated
    ? new Date(lastUpdated).toLocaleString('en-AU', { timeZone: 'Australia/Sydney' })
    : 'Never';
    
  // Format stats: "627 tasks (82 assigned, 627 subscribed)" - wait, we only have total and assigned
  // Total includes both subscribed and assigned.
  // Let's show: "627 tasks (5 assigned) • Synced: ..."
  const statsText = `${taskCount || 0} tasks (${assignedCount || 0} assigned)`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Productive Task Search</title>
  <style>
    :root, [data-theme="dark"] {
      --bg-primary: #0f0f0f;
      --bg-secondary: #1a1a1a;
      --bg-card: #242424;
      --border: #333;
      --text-primary: #f5f5f5;
      --text-secondary: #a0a0a0;
      --accent: #6366f1;
      --accent-hover: #818cf8;
      --success: #22c55e;
      --warning: #f59e0b;
      --error: #ef4444;
    }

    [data-theme="light"] {
      --bg-primary: #f8fafc;
      --bg-secondary: #ffffff;
      --bg-card: #ffffff;
      --border: #e2e8f0;
      --text-primary: #1e293b;
      --text-secondary: #64748b;
      --accent: #4f46e5;
      --accent-hover: #6366f1;
      --success: #16a34a;
      --warning: #d97706;
      --error: #dc2626;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg-primary);
      color: var(--text-primary);
      min-height: 100vh;
      padding: 1.5rem;
    }

    .container { max-width: 1000px; margin: 0 auto; }

    header { text-align: center; margin-bottom: 1.5rem; }

    h1 {
      font-size: 1.75rem;
      font-weight: 600;
      margin-bottom: 0.25rem;
      background: linear-gradient(135deg, var(--accent) 0%, #a855f7 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    .stats { color: var(--text-secondary); font-size: 0.8rem; }

    .search-box { margin-bottom: 1rem; }

    .search-input {
      width: 100%;
      padding: 0.875rem 1.25rem;
      font-size: 1rem;
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 10px;
      color: var(--text-primary);
      outline: none;
    }

    .search-input:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.2);
    }

    .search-input::placeholder { color: var(--text-secondary); }

    .filters {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      margin-bottom: 1rem;
      padding: 0.75rem;
      background: var(--bg-secondary);
      border-radius: 10px;
      border: 1px solid var(--border);
    }

    .filter-group {
      display: flex;
      align-items: center;
      gap: 0.25rem;
    }

    .filter-label {
      font-size: 0.75rem;
      color: var(--text-secondary);
      white-space: nowrap;
    }

    .filter-select {
      padding: 0.375rem 0.5rem;
      font-size: 0.8rem;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 6px;
      color: var(--text-primary);
      cursor: pointer;
      min-width: 100px;
    }

    .filter-select:focus {
      border-color: var(--accent);
      outline: none;
    }

    .actions {
      display: flex;
      gap: 0.5rem;
      margin-bottom: 1rem;
    }

    .btn {
      padding: 0.5rem 0.875rem;
      font-size: 0.8rem;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.2s;
      background: transparent;
    }

    .btn-primary { background: var(--accent); color: white; }
    .btn-primary:hover { background: var(--accent-hover); }

    .btn-secondary {
      background: var(--bg-secondary);
      color: var(--text-primary);
      border: 1px solid var(--border);
    }
    .btn-secondary:hover { background: var(--bg-card); }

    .btn-clear {
      background: transparent;
      color: var(--text-secondary);
      border: 1px solid var(--border);
      margin-left: auto;
    }
    .btn-clear:hover { color: var(--error); border-color: var(--error); }

    .results { display: flex; flex-direction: column; gap: 0.5rem; }

    .task-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 0.875rem 1rem;
      transition: border-color 0.2s;
    }

    .task-card:hover { border-color: var(--accent); }

    .task-header {
      display: flex;
      align-items: flex-start;
      gap: 0.5rem;
      margin-bottom: 0.375rem;
    }

    .ticket-key {
      font-family: 'SF Mono', Monaco, monospace;
      font-size: 0.8rem;
      font-weight: 600;
      color: var(--accent);
      background: rgba(99, 102, 241, 0.15);
      padding: 0.2rem 0.4rem;
      border-radius: 5px;
      white-space: nowrap;
    }

    .ticket-key a { color: inherit; text-decoration: none; }
    .ticket-key a:hover { text-decoration: underline; }

    .task-title { flex: 1; font-size: 0.95rem; line-height: 1.35; }
    .task-title a { color: var(--text-primary); text-decoration: none; }
    .task-title a:hover { color: var(--accent); }

    .task-actions { display: flex; gap: 0.375rem; }

    .copy-btn {
      padding: 0.2rem 0.4rem;
      font-size: 0.7rem;
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 5px;
      color: var(--text-secondary);
      cursor: pointer;
    }

    .copy-btn:hover { background: var(--accent); border-color: var(--accent); color: white; }
    .copy-btn.copied { background: var(--success); border-color: var(--success); color: white; }

    .task-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      font-size: 0.75rem;
      color: var(--text-secondary);
    }

    .task-meta span { display: flex; align-items: center; gap: 0.15rem; }

    .status-badge {
      padding: 0.1rem 0.4rem;
      border-radius: 9999px;
      font-size: 0.7rem;
      font-weight: 500;
    }

    .status-done { background: rgba(34, 197, 94, 0.2); color: var(--success); }
    .status-progress { background: rgba(99, 102, 241, 0.2); color: var(--accent); }
    .status-todo { background: rgba(160, 160, 160, 0.2); color: var(--text-secondary); }

    .task-dates {
      display: flex;
      gap: 0.75rem;
      font-size: 0.7rem;
      color: var(--text-secondary);
      margin-top: 0.25rem;
      opacity: 0.8;
    }

    .loading, .empty { text-align: center; padding: 2rem; color: var(--text-secondary); }

    .result-count { margin-bottom: 0.75rem; font-size: 0.8rem; color: var(--text-secondary); }

    @media (max-width: 640px) {
      body { padding: 1rem; }
      .filters { flex-direction: column; }
      .filter-group { width: 100%; }
      .filter-select { flex: 1; }
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div style="display: flex; justify-content: center; align-items: center; gap: 0.75rem;">
        <h1>Better Productive.io</h1>
        <button id="themeToggle" class="btn" style="padding: 0.375rem 0.5rem; font-size: 1rem;" title="Toggle theme">🌙</button>
      </div>
      <p class="stats">${statsText} • Synced: ${lastUpdatedDisplay}</p>
    </header>

    <div class="search-box">
      <input type="text" class="search-input" id="searchInput" 
             placeholder="Search by ticket (PRIM-242), title, status..." autofocus>
    </div>

    <div class="filters" id="filtersContainer">
      <div class="filter-group">
        <span class="filter-label">Project:</span>
        <select class="filter-select" id="filterProject" style="min-width: 180px;">
          <option value="">All</option>
        </select>
      </div>
      <div class="filter-group">
        <span class="filter-label">Status:</span>
        <select class="filter-select" id="filterStatus">
          <option value="">All</option>
        </select>
      </div>
      <div class="filter-group">
        <span class="filter-label">Due:</span>
        <select class="filter-select" id="filterDue">
          <option value="">Any</option>
          <option value="overdue">Overdue</option>
          <option value="today">Today</option>
          <option value="week">This Week</option>
          <option value="month">This Month</option>
          <option value="year">This Year</option>
          <option value="none">No Due Date</option>
        </select>
      </div>
      <div class="filter-group">
        <label style="display: flex; align-items: center; gap: 0.25rem; cursor: pointer; font-size: 0.8rem;">
          <input type="checkbox" id="filterMeOnly" style="accent-color: var(--accent);">
          <span>Assigned to me</span>
        </label>
      </div>
      <button class="btn btn-clear" onclick="clearFilters()">✕ Clear</button>
    </div>

    <div class="actions">
      <button class="btn btn-primary" onclick="updateNow()">🔄 Sync</button>
      <button class="btn btn-secondary" onclick="showPrefixes()">📋 Prefixes</button>
    </div>

    <div id="resultCount" class="result-count"></div>
    <div id="results" class="results">
      <div class="loading">Loading...</div>
    </div>
  </div>

  <script>
    // Theme toggle
    const themeToggle = document.getElementById('themeToggle');
    const savedTheme = localStorage.getItem('theme') || 'dark';
    document.documentElement.setAttribute('data-theme', savedTheme);
    themeToggle.textContent = savedTheme === 'dark' ? '🌙' : '☀️';
    
    themeToggle.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme') || 'dark';
      const next = current === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('theme', next);
      themeToggle.textContent = next === 'dark' ? '🌙' : '☀️';
    });

    const searchInput = document.getElementById('searchInput');
    const resultsDiv = document.getElementById('results');
    const resultCountDiv = document.getElementById('resultCount');
    const filterProject = document.getElementById('filterProject');
    const filterStatus = document.getElementById('filterStatus');
    const filterDue = document.getElementById('filterDue');
    const filterMeOnly = document.getElementById('filterMeOnly');
    
    let allTasks = [];
    let filteredTasks = [];
    let currentPersonId = null;
    let debounceTimer;
    
    // Pagination
    let currentPage = 1;
    const pageSize = 50;

    // Load filters and initial data
    loadFilters();
    loadTasks();

    // Event listeners
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        searchInput.focus();
        searchInput.select();
      }
      // Left/Right arrow for pagination
      if (document.activeElement !== searchInput) {
        if (e.key === 'ArrowLeft') changePage(-1);
        if (e.key === 'ArrowRight') changePage(1);
      }
    });

    searchInput.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(applyFilters, 200);
    });

    filterProject.addEventListener('change', applyFilters);
    filterStatus.addEventListener('change', applyFilters);
    filterDue.addEventListener('change', applyFilters);
    filterMeOnly.addEventListener('change', applyFilters);

    async function loadFilters() {
      try {
        const res = await fetch('/api/filters');
        if (!res.ok) throw new Error('Failed to load filters');
        const data = await res.json();
        
        // Populate Projects
        data.projects.forEach(p => {
          const option = document.createElement('option');
          option.value = p.prefix;
          option.textContent = p.name + ' (' + p.prefix + ')'; // Format: Project Name (PREFIX)
          filterProject.appendChild(option);
        });
        
        // Populate Statuses
        data.statuses.forEach(s => {
          const option = document.createElement('option');
          option.value = s;
          option.textContent = s;
          filterStatus.appendChild(option);
        });
        
        // Store current person ID
        currentPersonId = data.currentPersonId;
        
      } catch (err) {
        console.error('Error loading filters:', err);
      }
    }

    async function loadTasks() {
      try {
        const res = await fetch('/api/search?q=');
        if (!res.ok) throw new Error('Failed to load tasks');
        const data = await res.json();
        allTasks = data.tasks;
        filteredTasks = allTasks;
        applyFilters();
      } catch (err) {
        resultsDiv.innerHTML = '<div class="error">Failed to load tasks</div>';
      }
    }

    function applyFilters() {
      const query = searchInput.value.toLowerCase().trim();
      const project = filterProject.value;
      const status = filterStatus.value;
      const due = filterDue.value;
      const meOnly = filterMeOnly.checked;

      // Date calculations for filters
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      const tomorrow = today + 86400000;
      const nextWeek = today + (7 * 86400000);
      const nextMonth = today + (30 * 86400000);
      const nextYear = today + (365 * 86400000);

      filteredTasks = allTasks.filter(task => {
        // Text search
        if (query) {
          const searchText = (task.ticketKey + ' ' + task.title + ' ' + task.status + ' ' + task.assignee + ' ' + task.project).toLowerCase();
          if (!searchText.includes(query)) return false;
        }
        
        // Project filter
        if (project && task.projectPrefix !== project) return false;
        
        // Status filter
        if (status && task.status !== status) return false;
        
        // Assigned to me filter
        if (meOnly && task.assigneeId !== currentPersonId) return false;

        // Due date filter
        if (due) {
          if (due === 'none') return !task.dueDate;
          if (!task.dueDate) return false;
          
          const dueDate = new Date(task.dueDate).getTime();
          
          if (due === 'overdue') return dueDate < today;
          if (due === 'today') return dueDate >= today && dueDate < tomorrow;
          if (due === 'week') return dueDate >= today && dueDate < nextWeek;
          if (due === 'month') return dueDate >= today && dueDate < nextMonth;
          if (due === 'year') return dueDate >= today && dueDate < nextYear;
        }

        return true;
      });
      
      currentPage = 1;
      renderTasks();
    }
    
    function changePage(delta) {
      const maxPage = Math.ceil(filteredTasks.length / pageSize) || 1;
      const newPage = currentPage + delta;
      if (newPage >= 1 && newPage <= maxPage) {
        currentPage = newPage;
        renderTasks();
        // Scroll to top of results
        resultsDiv.scrollTop = 0;
      }
    }

    function renderTasks() {
      if (filteredTasks.length === 0) {
        resultsDiv.innerHTML = '<div class="empty">No tasks found</div>';
        resultCountDiv.textContent = '0 results';
        return;
      }
      
      const startIndex = (currentPage - 1) * pageSize;
      const EndIndex = Math.min(startIndex + pageSize, filteredTasks.length);
      const pageTasks = filteredTasks.slice(startIndex, EndIndex);
      
      // Pagination controls
      const maxPage = Math.ceil(filteredTasks.length / pageSize);
      const paginationHtml = maxPage > 1 ? 
        '<div style="display: flex; justify-content: center; align-items: center; gap: 1rem; margin-top: 1.5rem; padding-top: 1rem; border-top: 1px solid var(--border);">' +
          '<button class="btn btn-secondary" onclick="changePage(-1)" ' + (currentPage === 1 ? 'disabled' : '') + ' style="padding: 0.25rem 0.75rem;">Previous</button>' +
          '<span style="font-size: 0.9rem; color: var(--text-secondary);">Page ' + currentPage + ' of ' + maxPage + '</span>' +
          '<button class="btn btn-secondary" onclick="changePage(1)" ' + (currentPage === maxPage ? 'disabled' : '') + ' style="padding: 0.25rem 0.75rem;">Next</button>' +
        '</div>' : '';

      resultsDiv.innerHTML = pageTasks.map(renderTask).join('') + paginationHtml;
      resultCountDiv.textContent = filteredTasks.length + ' results' + (filteredTasks.length > pageSize ? ' (showing ' + (startIndex + 1) + '-' + EndIndex + ')' : '');
    }

    function clearFilters() {
      searchInput.value = '';
      filterProject.value = '';
      filterStatus.value = '';
      filterDue.value = '';
      filterMeOnly.checked = false;
      applyFilters();
    }

    function renderTask(task) {
      const statusClass = getStatusClass(task.status);
      const created = task.createdAt ? formatDate(task.createdAt) : '';
      const updated = task.updatedAt ? formatDate(task.updatedAt) : '';
      
      return \`
        <div class="task-card">
          <div class="task-header">
            <span class="ticket-key">
              <a href="/browse/\${task.ticketKey}" title="Open in Productive">\${task.ticketKey}</a>
            </span>
            <div class="task-title">
              <a href="\${task.url}" target="_blank">#\${task.ticketNumber} \${escapeHtml(task.title)}</a>
            </div>
            <div class="task-actions">
              <button class="copy-btn" onclick="copyMarkdown('\${task.ticketNumber}', '\${escapeJs(task.title)}', '\${task.url}', this)">📋</button>
            </div>
          </div>
          <div class="task-meta">
            <span class="status-badge \${statusClass}">\${escapeHtml(task.status)}</span>
            <span>👤 \${escapeHtml(task.assignee)}</span>
            <span>📁 \${escapeHtml(task.project)}</span>
            \${task.dueDate ? '<span>📅 ' + task.dueDate + '</span>' : ''}
          </div>
          <div class="task-dates">
            \${created ? '<span>Created: ' + created + '</span>' : ''}
            \${updated ? '<span>Updated: ' + updated + '</span>' : ''}
          </div>
        </div>
      \`;
    }

    function formatDate(iso) {
      if (!iso) return '';
      return new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
    }

    function getStatusClass(status) {
      const s = status.toLowerCase();
      if (s.includes('done') || s.includes('complete') || s.includes('closed')) return 'status-done';
      if (s.includes('progress') || s.includes('review') || s.includes('testing')) return 'status-progress';
      return 'status-todo';
    }

    function copyMarkdown(number, title, url, btn) {
      const markdown = '[#' + number + ' ' + title + '](' + url + ')';
      navigator.clipboard.writeText(markdown).then(() => {
        btn.textContent = '✓';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = '📋';
          btn.classList.remove('copied');
        }, 2000);
      });
    }

    async function updateNow() {
      resultsDiv.innerHTML = '<div class="loading">🔄 Syncing...</div>';
      try {
        const res = await fetch('/update');
        const data = await res.json();
        if (data.success) {
          alert('✅ Synced ' + data.taskCount + ' tasks');
          location.reload();
        } else {
          alert('❌ ' + data.error);
        }
      } catch (e) {
        alert('❌ ' + e.message);
      }
    }

    async function showPrefixes() {
      try {
        const res = await fetch('/api/prefixes');
        const data = await res.json();
        const list = Object.entries(data.prefixMap).map(([id, p]) => p + ' → ' + id).join('\\n');
        alert('Prefixes:\\n\\n' + list);
      } catch (e) {
        alert('❌ ' + e.message);
      }
    }

    function escapeHtml(str) {
      if (!str) return '';
      return str.replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
    }

    function escapeJs(str) {
      if (!str) return '';
      return str.replace(/[\\']/g, '\\\\$&').replace(/"/g, '\\\\"');
    }
  </script>
</body>
</html>`;
}

