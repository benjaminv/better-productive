# Changelog

All notable changes to Better Productive will be documented in this file.

## [0.4.0] - 2026-02-07

### Added
- **Cancel sync** — Abort an in-progress sync without affecting data
- Server-side abort signal support for clean cancellation

### Fixed
- Task titles with special characters (`[`, `]`, `"`, etc.) now copy correctly
- Removed unsafe inline JS escaping in favour of data attributes

### Optimised
- Baseline storage reduced by ~95% (stores only `id → updatedAt` map instead of full task objects)

---

## [0.3.0] - 2026-02-06

### Added
- **"What's New" feature** — Highlights tasks that changed since your last manual sync
  - Toggle to filter only new/updated tasks
  - Visual badge on changed task cards
  - Persists across cron syncs until you manually sync again
- **Real-time sync progress** — Server-Sent Events stream live page-by-page progress
  - Animated progress bar with pulsing segments
  - Processing state indicator for KV writes
- **Settings modal** — Centralised UI for:
  - Changing page title
  - Updating PIN
  - Updating API token
- **Sync cooldown** — 5-minute rate limit with countdown timer
- Dark/light theme toggle

### Changed
- Complete UI revamp with modern card-based design
- SVG icons throughout (Lucide icon set)
- Mobile-responsive layout improvements

---

## [0.2.0] - 2026-02-05

### Added
- **PIN authentication** — Secure your dashboard with a 4-8 digit PIN
  - First-time setup flow
  - Session management (7-day cookie with auto-expiry)
  - Logout functionality
- **Auto-detection** — Automatically detects your Productive.io organisation and person ID from API token
- **Copy filtered tasks** — Export filtered task list as Markdown with project groupings
- **PWA support** — Favicons, app icons, and web manifest for installable app experience
- Scheduled cron sync (every 6 hours)

### Changed
- Separated HTML template and CSS into distinct files
- Task display uses `#number` format instead of ticket key prefix

---

## [0.1.0] - 2026-02-04

### Added
- Initial release
- Fetch tasks from Productive.io API (subscribed + assigned)
- Search by ticket key, number, title, status, or assignee
- Filter by project, status, due date, and "assigned to me"
- Automatic project prefix generation (e.g., `PRIM-242`)
- Copy individual task as Markdown link
- Pagination (50 tasks per page)
- Preserves tasks no longer in API (marked as "Unknown" status)

---

## Roadmap

### Completed
- [x] Fetch tasks from Productive.io (subscribed + assigned)
- [x] Search by ticket key, number, title, status, or assignee
- [x] Filter by project, status, due date, and "assigned to me"
- [x] Automatic project prefix generation (e.g., `PRIM-242`)
- [x] Copy individual task as Markdown link
- [x] Copy filtered tasks as Markdown with project groupings
- [x] Pagination with keyboard navigation
- [x] PIN authentication with session management
- [x] Auto-detection of organisation and person ID from API token
- [x] Real-time sync progress with Server-Sent Events
- [x] "What's New" highlighting for changed tasks since last manual sync
- [x] Cancel in-progress sync
- [x] Dark/light theme toggle
- [x] PWA support (installable app)
- [x] Settings modal (title, PIN, API token)
- [x] Sync cooldown rate limiting
- [x] Scheduled background sync (cron)
- [x] Preserve deleted/unsubscribed tasks

### Planned
- [ ] Multi-user support (separate data per API token)
- [ ] Custom project prefix overrides
- [ ] Task status quick-actions (without leaving the dashboard)
- [ ] Keyboard shortcuts reference
- [ ] Export to CSV
- [ ] Webhook support for instant sync on Productive.io changes

### Considering
- [ ] Browser notifications for new tasks
- [ ] Time tracking integration
- [ ] Team view (see colleagues' assigned tasks)

---

*This project is not affiliated with Productive.io.*
