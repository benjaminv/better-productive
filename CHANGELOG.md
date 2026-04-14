# Changelog

All notable changes to Better Productive will be documented in this file.

## [0.9.0] - 2026-04-14

### Added
- **Remote search & manual ghosts** — Look up tickets you're not subscribed/assigned to directly from the search input
  - As you type, a transparent dropdown surfaces matches found on Productive.io that aren't yet in your KV
  - Supports ticket-key (`PRIM-242`), bare number (`#242`), and free-text queries
  - `+ Add` pins a remote ticket as a "manual ghost" with the same dashed-border styling as derived ghost parents
  - Manual ghosts persist across full syncs (tracked via `_manual: true`); auto-promoted to regular tasks if you later get subscribed/assigned
  - New projects pulled in via manual add automatically get a generated, collision-safe prefix
  - Off by default — enable in Settings → Features
- **Search input UX**
  - Inline count swaps from `1027 tasks (34 assigned)` to `N results` while a query is active
  - ✕ clear button at the far right of the input
  - Two-stage `Esc`: first dismisses the remote dropdown, second clears the input

## [0.8.3] - 2026-03-25

### Added
- **View state persistence** — All filter and sort selections (project, status, due, custom date, exact-date toggle, my tasks, exclude resolved, sort) persist across page loads via `localStorage`
- Clear button removes the persisted state for a true reset

## [0.8.2] - 2026-03-25

### Changed
- "Today" Due filter now covers overdue + today (was exact today only) so you don't miss overdues

### Fixed
- iOS empty-box datepicker — Custom Date now prefills today
- Timezone bug where `toISOString()` showed previous day in AEDT — switched to explicit local `YYYY-MM-DD` formatting

## [0.8.0] - 2026-03-XX

### Added
- **Project-grouped view** with parent/subtask hierarchy (Project A-Z sort)
- **Ghost parent cards** — unsubscribed parent tasks render with dashed border, derived from API included data
- Clickable project links in task cards
- Smart single-task sync — ghost parents update children without polluting KV

## [0.7.0] - 2026-02-24

### Added
- **Custom due date filter** — Select "Custom Date..." in the Due dropdown to filter by a specific date
  - "On or before" mode (default) shows tasks due up to the selected date
  - "On this date" checkbox for exact-date matching
  - State resets when switching away from Custom; mobile-responsive layout
- **Deleted task status** — Removed tasks now display as "Deleted" instead of "Unknown"
- **Dynamic What's New count** — "New" badge count updates based on currently filtered results instead of showing total

### Fixed
- Date input appearance normalised across browsers
- Custom date filter state properly resets when switching to other due-date presets
- Robust date input clearing using `valueAsDate = null`

---

## [0.6.0] - 2026-02-19

### Added
- **Single task sync** — Refresh icon on each task card to pull latest data from Productive.io without a full sync or cooldown

### Fixed
- Mobile: Sync button hides "Sync" text during cooldown countdown to prevent row overflow

---

## [0.5.0] - 2026-02-18

### Added
- **Exclude Resolved filter** — Checkbox to hide Done/Complete/Cancel/Closed/Unknown tasks (checked by default)
  - Auto-toggles when selecting resolved statuses in the Status dropdown
  - Clear button resets to unchecked (show all)
- **Sort dropdown** — Sort tasks by Project, Due Date, Created, or Updated (moved to actions row)
- **Resolved status array** — Centralised `RESOLVED_STATUSES` constant for easier maintenance
- Synced timestamp shown in desktop header and mobile stats row
- Task count displayed inside search input (gradient transparency)

### Changed
- Search placeholder updated to "ticket number, title, status..."
- Filter select dropdowns capped with `max-width` and text overflow
- Mobile stats row simplified (no background/border)
- Cancelled tasks now treated as resolved throughout

---

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