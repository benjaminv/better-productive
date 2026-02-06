// Productive.io Task Search with Jira-style URLs
// A Cloudflare Worker that provides searchable task database with /browse/PRIM-242 redirects

import htmlTemplate from './template.html';
import authTemplate from './auth.html';
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

// Session cookie name
const SESSION_COOKIE = 'bp_session';
const SESSION_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 days

// =============================================================================
// Configuration Helper - Check Env then KV
// =============================================================================

async function getConfig(env) {
  // Priority 1: Environment variables / secrets
  let apiToken = env.PRODUCTIVE_API_TOKEN || null;
  let appPin = env.APP_PIN || null;
  
  // Priority 2: KV storage fallback
  if (!apiToken && env.TASKS_KV) {
    apiToken = await env.TASKS_KV.get('config_api_token');
  }
  if (!appPin && env.TASKS_KV) {
    appPin = await env.TASKS_KV.get('config_app_pin');
  }
  
  return {
    apiToken,
    appPin,
    setupToken: env.SETUP_TOKEN || null,
    isConfigured: !!apiToken,
    isProtected: !!appPin
  };
}

// =============================================================================
// Authentication Helpers
// =============================================================================

function generateSessionToken() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
}

async function hashPin(pin) {
  const encoder = new TextEncoder();
  const data = encoder.encode(pin);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

function parseSessionCookie(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  return match ? match[1] : null;
}

async function isAuthenticated(request, env) {
  const config = await getConfig(env);
  
  // If no PIN is set, no auth required
  if (!config.isProtected) {
    return true;
  }
  
  // Check for valid session cookie
  const sessionToken = parseSessionCookie(request);
  if (!sessionToken) {
    return false;
  }
  
  // Verify session exists in KV
  const session = await env.TASKS_KV.get(`session_${sessionToken}`);
  return !!session;
}

async function createSession(env) {
  const token = generateSessionToken();
  const expires = Date.now() + SESSION_DURATION;
  
  // Store session in KV with expiration
  await env.TASKS_KV.put(`session_${token}`, JSON.stringify({ created: Date.now() }), {
    expirationTtl: Math.floor(SESSION_DURATION / 1000)
  });
  
  return {
    token,
    cookie: `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(SESSION_DURATION / 1000)}`
  };
}

async function destroySession(request, env) {
  const sessionToken = parseSessionCookie(request);
  if (sessionToken) {
    await env.TASKS_KV.delete(`session_${sessionToken}`);
  }
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

// =============================================================================
// Auth Page Renderer
// =============================================================================

function renderAuthPage({ title, subtitle, fields, submitText, error, success, footer }) {
  let html = authTemplate
    .replace('{{STYLES}}', styles)
    .replace(/\{\{PAGE_TITLE\}\}/g, title)
    .replace('{{PAGE_SUBTITLE}}', subtitle)
    .replace('{{SUBMIT_TEXT}}', submitText)
    .replace('{{ERROR_MESSAGE}}', error ? `<div class="error-message">${error}</div>` : '')
    .replace('{{SUCCESS_MESSAGE}}', success ? `<div class="success-message">${success}</div>` : '')
    .replace('{{FOOTER_CONTENT}}', footer || '');
  
  // Build form fields
  const fieldsHtml = fields.map(f => `
    <div class="form-group">
      <label for="${f.name}">${f.label}</label>
      <input type="${f.type}" name="${f.name}" id="${f.name}" 
             class="form-input" placeholder="${f.placeholder || ''}" 
             ${f.required ? 'required' : ''} ${f.autocomplete ? `autocomplete="${f.autocomplete}"` : ''}>
      ${f.hint ? `<div class="hint">${f.hint}</div>` : ''}
    </div>
  `).join('');
  
  html = html.replace('{{FORM_FIELDS}}', fieldsHtml);
  
  return new Response(html, {
    headers: { 'Content-Type': 'text/html' }
  });
}

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
      // Static asset routes (always public)
      const asset = staticAssets[url.pathname];
      if (asset) {
        return new Response(asset.content, {
          headers: { 
            'Content-Type': asset.type,
            'Cache-Control': 'public, max-age=86400'
          }
        });
      }

      // Get current configuration
      const config = await getConfig(env);

      // =================================================================
      // Setup Route - First-time configuration
      // =================================================================
      if (url.pathname === '/setup') {
        // If already configured, redirect to home
        if (config.isConfigured) {
          return Response.redirect(new URL('/', url.origin), 302);
        }
        
        // Require SETUP_TOKEN if configured (security measure)
        if (config.setupToken) {
          const providedToken = url.searchParams.get('token');
          if (providedToken !== config.setupToken) {
            return renderAuthPage({
              title: 'Setup Required',
              subtitle: 'A setup token is required to configure this app.',
              fields: [],
              submitText: '',
              error: 'Please add ?token=YOUR_SETUP_TOKEN to the URL to proceed.',
              footer: '<div class="footer-text">Set SETUP_TOKEN via <code>wrangler secret put SETUP_TOKEN</code></div>'
            });
          }
        }
        
        if (request.method === 'POST') {
          return handleSetupPost(request, env, url);
        }
        
        return renderAuthPage({
          title: 'Welcome! 👋',
          subtitle: 'Let\'s set up your Better Productive.io dashboard.',
          fields: [
            { 
              name: 'api_token', 
              label: 'Productive API Token', 
              type: 'password', 
              placeholder: 'Enter your API token',
              hint: 'Get this from Productive.io → Settings → API',
              required: true,
              autocomplete: 'off'
            },
            { 
              name: 'app_pin', 
              label: 'App PIN', 
              type: 'password', 
              placeholder: '4-8 digit PIN',
              hint: 'Protect your dashboard with a PIN',
              required: true,
              autocomplete: 'new-password'
            }
          ],
          submitText: 'Complete Setup',
          footer: '<div class="footer-text">Your credentials are stored securely in Cloudflare KV.</div>'
        });
      }

      // =================================================================
      // Login Route
      // =================================================================
      if (url.pathname === '/login') {
        // If not configured, redirect to setup
        if (!config.isConfigured) {
          return Response.redirect(new URL('/setup', url.origin), 302);
        }
        
        // If no PIN protection, redirect to home
        if (!config.isProtected) {
          return Response.redirect(new URL('/', url.origin), 302);
        }
        
        // If already authenticated, redirect to home
        if (await isAuthenticated(request, env)) {
          return Response.redirect(new URL('/', url.origin), 302);
        }
        
        if (request.method === 'POST') {
          return handleLoginPost(request, env, url);
        }
        
        return renderAuthPage({
          title: 'Login',
          subtitle: 'Enter your PIN to access the dashboard.',
          fields: [
            { 
              name: 'pin', 
              label: 'PIN', 
              type: 'password', 
              placeholder: 'Enter your PIN',
              required: true,
              autocomplete: 'current-password'
            }
          ],
          submitText: 'Login'
        });
      }

      // =================================================================
      // Logout Route
      // =================================================================
      if (url.pathname === '/logout') {
        const clearCookie = await destroySession(request, env);
        return new Response(null, {
          status: 302,
          headers: {
            'Location': '/login',
            'Set-Cookie': clearCookie
          }
        });
      }

      // =================================================================
      // Check Configuration - Redirect to setup if not configured
      // =================================================================
      if (!config.isConfigured) {
        return Response.redirect(new URL('/setup', url.origin), 302);
      }

      // =================================================================
      // Check Authentication for Protected Routes
      // =================================================================
      const publicRoutes = ['/api/'];
      const isPublicRoute = publicRoutes.some(r => url.pathname.startsWith(r));
      
      if (!isPublicRoute && config.isProtected) {
        const authenticated = await isAuthenticated(request, env);
        if (!authenticated) {
          return Response.redirect(new URL('/login', url.origin), 302);
        }
      }

      // =================================================================
      // Main Application Routes
      // =================================================================

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
        case '/api/settings':
          return handleSettings(request, env);
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
// Setup & Login Handlers
// =============================================================================

async function handleSetupPost(request, env, url) {
  try {
    const formData = await request.formData();
    const apiToken = formData.get('api_token')?.trim();
    const appPin = formData.get('app_pin')?.trim();
    
    // Validate both fields are provided
    if (!apiToken || !appPin) {
      const missingField = !apiToken ? 'API Token is required.' : 'PIN is required.';
      return renderAuthPage({
        title: 'Welcome! 👋',
        subtitle: 'Let\'s set up your Better Productive.io dashboard.',
        fields: [
          { name: 'api_token', label: 'Productive API Token', type: 'password', placeholder: 'Enter your API token', hint: 'Get this from Productive.io → Settings → API', required: true, autocomplete: 'off' },
          { name: 'app_pin', label: 'App PIN', type: 'password', placeholder: '4-8 digit PIN', hint: 'Protect your dashboard with a PIN', required: true, autocomplete: 'new-password' }
        ],
        submitText: 'Complete Setup',
        error: missingField
      });
    }
    
    // Validate API token by making a test request
    const testResponse = await fetch('https://api.productive.io/api/v2/organizations', {
      headers: {
        'X-Auth-Token': apiToken,
        'Content-Type': 'application/vnd.api+json'
      }
    });
    
    if (!testResponse.ok) {
      return renderAuthPage({
        title: 'Welcome! 👋',
        subtitle: 'Let\'s set up your Better Productive.io dashboard.',
        fields: [
          { name: 'api_token', label: 'Productive API Token', type: 'password', placeholder: 'Enter your API token', hint: 'Get this from Productive.io → Settings → API', required: true, autocomplete: 'off' },
          { name: 'app_pin', label: 'App PIN', type: 'password', placeholder: '4-8 digit PIN', hint: 'Protect your dashboard with a PIN', required: true, autocomplete: 'new-password' }
        ],
        submitText: 'Complete Setup',
        error: 'Invalid API Token. Please check and try again.'
      });
    }
    
    // Validate PIN format (4-8 digits)
    if (!/^\d{4,8}$/.test(appPin)) {
      return renderAuthPage({
        title: 'Welcome! 👋',
        subtitle: 'Let\'s set up your Better Productive.io dashboard.',
        fields: [
          { name: 'api_token', label: 'Productive API Token', type: 'password', placeholder: 'Enter your API token', hint: 'Get this from Productive.io → Settings → API', required: true, autocomplete: 'off' },
          { name: 'app_pin', label: 'App PIN', type: 'password', placeholder: '4-8 digit PIN', hint: 'Protect your dashboard with a PIN', required: true, autocomplete: 'new-password' }
        ],
        submitText: 'Complete Setup',
        error: 'PIN must be 4-8 digits.'
      });
    }
    
    // Store configuration in KV
    await env.TASKS_KV.put('config_api_token', apiToken);
    const hashedPin = await hashPin(appPin);
    await env.TASKS_KV.put('config_app_pin', hashedPin);
    
    // Redirect to login (PIN is always set now)
    return Response.redirect(new URL('/login', url.origin), 302);
    
  } catch (error) {
    console.error('Setup error:', error);
    return renderAuthPage({
      title: 'Welcome! 👋',
      subtitle: 'Let\'s set up your Better Productive.io dashboard.',
      fields: [
        { name: 'api_token', label: 'Productive API Token', type: 'password', placeholder: 'Enter your API token', hint: 'Get this from Productive.io → Settings → API', required: true, autocomplete: 'off' },
        { name: 'app_pin', label: 'App PIN', type: 'password', placeholder: '4-8 digit PIN', hint: 'Protect your dashboard with a PIN', required: true, autocomplete: 'new-password' }
      ],
      submitText: 'Complete Setup',
      error: `Setup failed: ${error.message}`
    });
  }
}

async function handleLoginPost(request, env, url) {
  try {
    const formData = await request.formData();
    const pin = formData.get('pin')?.trim();
    
    if (!pin) {
      return renderAuthPage({
        title: 'Login',
        subtitle: 'Enter your PIN to access the dashboard.',
        fields: [{ name: 'pin', label: 'PIN', type: 'password', placeholder: 'Enter your PIN', required: true, autocomplete: 'current-password' }],
        submitText: 'Login',
        error: 'Please enter your PIN.'
      });
    }
    
    // Check PIN - env var takes priority (plaintext), then KV (hashed)
    let isValidPin = false;
    
    if (env.APP_PIN) {
      // Compare against plaintext env var (convert to string for comparison)
      isValidPin = (pin === String(env.APP_PIN));
    } else {
      // Compare against hashed KV value
      const storedPinHash = await env.TASKS_KV.get('config_app_pin');
      if (storedPinHash) {
        const inputPinHash = await hashPin(pin);
        isValidPin = (inputPinHash === storedPinHash);
      }
    }
    
    if (!isValidPin) {
      return renderAuthPage({
        title: 'Login',
        subtitle: 'Enter your PIN to access the dashboard.',
        fields: [{ name: 'pin', label: 'PIN', type: 'password', placeholder: 'Enter your PIN', required: true, autocomplete: 'current-password' }],
        submitText: 'Login',
        error: 'Incorrect PIN. Please try again.'
      });
    }
    
    // Create session and redirect
    const session = await createSession(env);
    return new Response(null, {
      status: 302,
      headers: {
        'Location': '/',
        'Set-Cookie': session.cookie
      }
    });
    
  } catch (error) {
    console.error('Login error:', error);
    return renderAuthPage({
      title: 'Login',
      subtitle: 'Enter your PIN to access the dashboard.',
      fields: [{ name: 'pin', label: 'PIN', type: 'password', placeholder: 'Enter your PIN', required: true, autocomplete: 'current-password' }],
      submitText: 'Login',
      error: `Login failed: ${error.message}`
    });
  }
}

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
  const config = await getConfig(env);
  const apiToken = config.apiToken;
  
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
  const config = await getConfig(env);
  const apiToken = config.apiToken;
  
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

async function updateTaskDatabase(env, onProgress = null) {
  const config = await getConfig(env);
  const apiToken = config.apiToken;
  
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
  
  // Track total pages fetched for progress
  let totalPagesFetched = 0;

  // Helper to fetch paginated tasks with a specific filter
  async function fetchTasksWithFilter(filterParam, filterValue, filterLabel) {
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
      totalPagesFetched++;
      
      // Report progress if callback provided
      if (onProgress) {
        onProgress({
          phase: filterLabel,
          page: page,
          hasMore: hasMore,
          tasksFound: taskMap.size,
          totalPages: totalPagesFetched
        });
      }
      
      page++;
    }
  }

  // Fetch BOTH subscribed AND assigned tasks
  if (personId) {
    await fetchTasksWithFilter('subscriber_id', personId, 'subscribed');
    await fetchTasksWithFilter('assignee_id', personId, 'assigned');
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
  
  // Detect new and updated tasks
  const existingUpdatedAtMap = new Map(existingTasks.map(t => [t.id, t.updatedAt]));
  const changedTaskIds = [];
  const newTaskIds = [];
  const updatedTaskIds = [];
  
  for (const task of allTasks) {
    if (task._deleted) continue; // Skip deleted tasks
    
    const existingUpdatedAt = existingUpdatedAtMap.get(task.id);
    if (!existingUpdatedAt) {
      // New task (not in previous sync)
      newTaskIds.push(task.id);
      changedTaskIds.push(task.id);
    } else if (existingUpdatedAt !== task.updatedAt) {
      // Updated task (updatedAt changed)
      updatedTaskIds.push(task.id);
      changedTaskIds.push(task.id);
    }
  }
  
  // Store changed task IDs in KV
  await env.TASKS_KV.put('changed_task_ids', JSON.stringify(changedTaskIds));
  await env.TASKS_KV.put('new_task_ids', JSON.stringify(newTaskIds));
  await env.TASKS_KV.put('updated_task_ids', JSON.stringify(updatedTaskIds));
  
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
    prefixes: prefixMap,
    changedCount: changedTaskIds.length,
    newCount: newTaskIds.length,
    updatedCount: updatedTaskIds.length
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
  const [projectsJson, statusesJson, assigneesJson, currentPersonId, changedIdsJson] = await Promise.all([
    env.TASKS_KV.get('filter_projects'),
    env.TASKS_KV.get('filter_statuses'),
    env.TASKS_KV.get('filter_assignees'),
    env.TASKS_KV.get('current_person_id'),
    env.TASKS_KV.get('changed_task_ids')
  ]);

  return new Response(JSON.stringify({
    projects: JSON.parse(projectsJson || '[]'),
    statuses: JSON.parse(statusesJson || '[]'),
    assignees: JSON.parse(assigneesJson || '[]'),
    currentPersonId: currentPersonId || null,
    changedTaskIds: JSON.parse(changedIdsJson || '[]')
  }), { headers: corsHeaders() });
}

async function handleSettings(request, env) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: corsHeaders()
    });
  }
  
  try {
    const body = await request.json();
    const { action, value } = body;
    
    if (!action || !value) {
      return new Response(JSON.stringify({ error: 'Missing action or value' }), {
        status: 400,
        headers: corsHeaders()
      });
    }
    
    switch (action) {
      case 'title':
        await env.TASKS_KV.put('config_page_title', value.trim());
        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders() });
        
      case 'pin':
        if (!/^\d{4,8}$/.test(value)) {
          return new Response(JSON.stringify({ error: 'PIN must be 4-8 digits' }), {
            status: 400,
            headers: corsHeaders()
          });
        }
        const hashedPin = await hashPin(value);
        await env.TASKS_KV.put('config_app_pin', hashedPin);
        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders() });
        
      case 'token':
        // Validate token by making a test request
        const testResponse = await fetch('https://api.productive.io/api/v2/organizations', {
          headers: {
            'X-Auth-Token': value,
            'Content-Type': 'application/vnd.api+json'
          }
        });
        
        if (!testResponse.ok) {
          return new Response(JSON.stringify({ error: 'Invalid API token' }), {
            status: 400,
            headers: corsHeaders()
          });
        }
        
        await env.TASKS_KV.put('config_api_token', value);
        // Clear cached org info so it's re-fetched with new token
        await env.TASKS_KV.delete('organization_info');
        await env.TASKS_KV.delete('current_person_id');
        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders() });
        
      default:
        return new Response(JSON.stringify({ error: 'Unknown action' }), {
          status: 400,
          headers: corsHeaders()
        });
    }
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: corsHeaders()
    });
  }
}

async function handleManualUpdate(request, env) {
  // Use Server-Sent Events to stream progress
  const encoder = new TextEncoder();
  
  const stream = new ReadableStream({
    async start(controller) {
      const sendEvent = (data) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };
      
      try {
        // Send initial connecting event
        sendEvent({ type: 'connecting', message: 'Connecting...' });
        
        // Progress callback for updateTaskDatabase
        const onProgress = (progress) => {
          sendEvent({
            type: 'progress',
            phase: progress.phase,
            page: progress.page,
            hasMore: progress.hasMore,
            tasksFound: progress.tasksFound,
            totalPages: progress.totalPages
          });
        };
        
        const result = await updateTaskDatabase(env, onProgress);
        
        // Send completion event
        sendEvent({
          type: 'complete',
          success: true,
          taskCount: result.taskCount,
          assignedCount: result.assignedCount,
          changedCount: result.changedCount,
          newCount: result.newCount,
          updatedCount: result.updatedCount
        });
        
      } catch (error) {
        sendEvent({
          type: 'error',
          success: false,
          error: error.message
        });
      } finally {
        controller.close();
      }
    }
  });
  
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

// =============================================================================
// HTML UI
// =============================================================================

async function renderSearchPage(env) {
  const [lastUpdated, taskCount, assignedCount, config, pageTitle] = await Promise.all([
    env.TASKS_KV.get('last_updated'),
    env.TASKS_KV.get('task_count'),
    env.TASKS_KV.get('assigned_count'),
    getConfig(env),
    env.TASKS_KV.get('config_page_title')
  ]);

  const lastUpdatedDisplay = lastUpdated
    ? new Date(lastUpdated).toLocaleString('en-AU', { timeZone: 'Australia/Sydney' })
    : 'Never';
    
  const statsText = `${taskCount || 0} tasks (${assignedCount || 0} assigned)`;
  
  // Default page title
  const displayTitle = pageTitle || 'Better Productive.io';
  
  // Detect if PIN/token are from env vars
  const pinFromEnv = !!env.APP_PIN;
  const tokenFromEnv = !!env.PRODUCTIVE_API_TOKEN;
  
  // Generate PIN section content
  const pinSection = pinFromEnv
    ? `<div class="form-group">
        <label>PIN</label>
        <p class="hint" style="margin-top: 0;">Managed via environment variable. To update:</p>
        <code class="hint" style="display: block; background: var(--bg-card); padding: 0.5rem; border-radius: 6px; margin-top: 0.25rem; font-size: 0.75rem;">wrangler secret put APP_PIN</code>
        <p class="hint">Or update in Cloudflare Dashboard → Workers → Settings → Variables</p>
      </div>`
    : `<div class="form-group">
        <label for="settingsPin">Update PIN</label>
        <div class="modal-row">
          <input type="password" id="settingsPin" class="form-input" placeholder="New 4-8 digit PIN" autocomplete="new-password">
          <button class="btn btn-save" onclick="savePin()">Save</button>
        </div>
        <p class="hint">Leave empty to keep current PIN</p>
      </div>`;
  
  // Generate token section content
  const tokenSection = tokenFromEnv
    ? `<div class="form-group">
        <label>API Token</label>
        <p class="hint" style="margin-top: 0;">Managed via environment variable. To update:</p>
        <code class="hint" style="display: block; background: var(--bg-card); padding: 0.5rem; border-radius: 6px; margin-top: 0.25rem; font-size: 0.75rem;">wrangler secret put PRODUCTIVE_API_TOKEN</code>
        <p class="hint">Or update in Cloudflare Dashboard → Workers → Settings → Variables</p>
      </div>`
    : `<div class="form-group">
        <label for="settingsToken">Update API Token</label>
        <div class="modal-row">
          <input type="password" id="settingsToken" class="form-input" placeholder="New Productive API token" autocomplete="off">
          <button class="btn btn-save" onclick="saveToken()">Save</button>
        </div>
        <p class="hint">Get from Productive.io → Settings → API</p>
      </div>`;
  
  // Show logout section only if PIN protection is enabled
  const logoutSection = config.isProtected 
    ? `<div class="modal-section">
        <h3>Session</h3>
        <a href="/logout" class="btn btn-danger btn-full">Logout</a>
      </div>`
    : '';

  // Replace placeholders in template
  return htmlTemplate
    .replace(/\{\{STYLES\}\}/g, styles)
    .replace(/\{\{PAGE_TITLE\}\}/g, displayTitle)
    .replace(/\{\{STATS_TEXT\}\}/g, statsText)
    .replace(/\{\{LAST_UPDATED\}\}/g, lastUpdatedDisplay)
    .replace(/\{\{PIN_SECTION\}\}/g, pinSection)
    .replace(/\{\{TOKEN_SECTION\}\}/g, tokenSection)
    .replace(/\{\{LOGOUT_SECTION\}\}/g, logoutSection);
}
