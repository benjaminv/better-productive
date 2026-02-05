// Productive.io Task Search with Jira-style URLs
// A Cloudflare Worker that provides searchable task database with /browse/PRIM-242 redirects

import htmlTemplate from './template.html';
import styles from './styles.css';

// Static assets
import logoSvg from './assets/logo.svg';
import favicon from './assets/favicon.ico';
import favicon16 from './assets/favicon-16x16.png';
import favicon32 from './assets/favicon-32x32.png';
import appleTouchIcon from './assets/apple-touch-icon.png';
import androidChrome192 from './assets/android-chrome-192x192.png';
import androidChrome512 from './assets/android-chrome-512x512.png';
import webmanifest from './assets/site.webmanifest';

// Static asset map for routing
const staticAssets = {
  '/logo.svg': { content: logoSvg, type: 'image/svg+xml' },
  '/favicon.ico': { content: favicon, type: 'image/x-icon', binary: true },
  '/favicon-16x16.png': { content: favicon16, type: 'image/png', binary: true },
  '/favicon-32x32.png': { content: favicon32, type: 'image/png', binary: true },
  '/apple-touch-icon.png': { content: appleTouchIcon, type: 'image/png', binary: true },
  '/android-chrome-192x192.png': { content: androidChrome192, type: 'image/png', binary: true },
  '/android-chrome-512x512.png': { content: androidChrome512, type: 'image/png', binary: true },
  '/site.webmanifest': { content: webmanifest, type: 'application/manifest+json' }
};

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
      // Static asset routes
      const asset = staticAssets[url.pathname];
      if (asset) {
        return new Response(asset.content, {
          headers: { 
            'Content-Type': asset.type,
            'Cache-Control': 'public, max-age=86400'
          }
        });
      }

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

// Get organization info from API or cache/env
async function getOrganizationInfo(env) {
  const apiToken = env.PRODUCTIVE_API_TOKEN;
  
  // Check if hardcoded in env first
  if (env.PRODUCTIVE_ORG_ID && env.PRODUCTIVE_ORG_SLUG) {
    return {
      orgId: env.PRODUCTIVE_ORG_ID,
      orgSlug: env.PRODUCTIVE_ORG_SLUG
    };
  }
  
  // Check cache
  const cachedOrg = await env.TASKS_KV.get('organization_info');
  if (cachedOrg) {
    return JSON.parse(cachedOrg);
  }
  
  // Fetch from API - organizations endpoint doesn't need org ID header
  const response = await fetch(
    'https://api.productive.io/api/v2/organizations',
    {
      headers: {
        'X-Auth-Token': apiToken,
        'Content-Type': 'application/vnd.api+json'
      }
    }
  );
  
  if (!response.ok) {
    throw new Error('Failed to fetch organization info from API');
  }
  
  const data = await response.json();
  
  // Get the first (usually only) organization
  if (!data.data || data.data.length === 0) {
    throw new Error('No organizations found for this API token');
  }
  
  const org = data.data[0];
  const attrs = org.attributes || {};
  
  if (!attrs.name) {
    throw new Error('Organization name not found in API response');
  }
  
  // Derive slug from organization name (lowercase, remove special chars)
  const orgSlug = attrs.name.toLowerCase().replace(/[^a-z0-9]/g, '');
  
  const orgInfo = {
    orgId: org.id,
    orgSlug: orgSlug
  };
  
  console.log('Detected organization:', orgInfo);
  
  // Cache it
  await env.TASKS_KV.put('organization_info', JSON.stringify(orgInfo));
  
  return orgInfo;
}

// Get the current user's person ID from API or cache
async function getPersonId(env, orgId) {
  const apiToken = env.PRODUCTIVE_API_TOKEN;
  
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
  
  if (!apiToken) {
    throw new Error('PRODUCTIVE_API_TOKEN not configured');
  }
  
  // Get organization info from cache or API (auto-detected)
  const { orgId, orgSlug } = await getOrganizationInfo(env);
  
  // Get person ID from cache or API (auto-detected)
  const personId = await getPersonId(env, orgId);

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
    
  const statsText = `${taskCount || 0} tasks (${assignedCount || 0} assigned)`;

  // Replace placeholders in template
  return htmlTemplate
    .replace('{{STYLES}}', styles)
    .replace('{{STATS_TEXT}}', statsText)
    .replace('{{LAST_UPDATED}}', lastUpdatedDisplay);
}
