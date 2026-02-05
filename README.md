# Better Productive.io

A fast, searchable task dashboard for [Productive.io](https://productive.io) built as a Cloudflare Worker. Features Jira-style ticket URLs (`/browse/PRIM-242`), powerful filtering, and markdown export.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-orange)

## ✨ Features

- **🔍 Fast Search** - Search across all tasks by ticket number, title, status, or assignee
- **🎫 Jira-style URLs** - Access tasks via `/browse/PRIM-242` style URLs
- **🎯 Smart Filtering** - Filter by project, status, due date, and assignee
- **📋 Markdown Export** - Copy filtered tasks as markdown checklists
- **🌙 Dark/Light Mode** - Toggle between themes
- **⚡ Auto-Sync** - Automatically syncs tasks during business hours
- **🔐 Secure** - API tokens stored as Cloudflare Secrets

## 🚀 Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) (`npm install -g wrangler`)
- A [Productive.io](https://productive.io) account with API access

### Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/yourusername/productiver.git
   cd productiver
   npm install
   ```

2. **Copy the config template**
   ```bash
   cp wrangler.toml.example wrangler.toml
   ```

3. **Create a KV namespace**
   ```bash
   wrangler kv namespace create TASKS_KV
   ```
   Copy the output ID into `wrangler.toml`:
   ```toml
   [[kv_namespaces]]
   binding = "TASKS_KV"
   id = "your-namespace-id-here"
   ```

4. **Set your API token as a secret**
   ```bash
   wrangler secret put PRODUCTIVE_API_TOKEN
   ```
   Get your API token from: Productive.io → Settings → API → Personal Access Tokens

5. **Deploy!**
   ```bash
   npm run deploy
   ```

That's it! Your org ID, slug, and person ID are auto-detected from the API.

## 🛠️ Development

### Local Development

1. Create a `.dev.vars` file for local secrets:
   ```bash
   echo "PRODUCTIVE_API_TOKEN=your_token_here" > .dev.vars
   ```

2. Start the dev server:
   ```bash
   npm run dev
   ```

3. Open http://localhost:8787

### Project Structure

```
src/
├── index.js          # Worker logic, API routes
├── template.html     # HTML + JavaScript
├── styles.css        # CSS styles
└── assets/           # Logo and favicons
    ├── logo.svg
    ├── favicon.ico
    └── ...
```

## ⚙️ Configuration

All environment variables are **optional** - they're auto-detected from the API if not set:

| Variable | Description | Default |
|----------|-------------|---------|
| `PRODUCTIVE_API_TOKEN` | **Required.** Your Productive.io API token | - |
| `PRODUCTIVE_ORG_ID` | Organization ID | Auto-detected |
| `PRODUCTIVE_ORG_SLUG` | Organization slug for URLs | Auto-detected |
| `PRODUCTIVE_PERSON_ID` | Your person ID for "Assigned to me" | Auto-detected |

### Cron Schedule

By default, tasks sync hourly during AEDT business hours (Mon-Fri 7am-7pm). Adjust in `wrangler.toml`:

```toml
[triggers]
crons = [
  "0 20-23 * * SUN-THU",  # 7-10 AM AEDT
  "0 0-8 * * MON-FRI"     # 11 AM-7 PM AEDT
]
```

## 📖 API Routes

| Route | Description |
|-------|-------------|
| `GET /` | Search UI |
| `GET /browse/PRIM-242` | Redirect to Productive.io task |
| `GET /api/search?q=text` | Search tasks (JSON) |
| `GET /api/filters` | Get available filters |
| `GET /update` | Trigger manual sync |

## 🔒 Security

- API token is stored as a [Cloudflare Secret](https://developers.cloudflare.com/workers/configuration/secrets/)
- Never commit `.dev.vars` (it's in `.gitignore`)
- For additional access control, consider [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/applications/)

## 📝 License

MIT License - see [LICENSE](LICENSE) for details.

## 🙏 Acknowledgments

- Built with [Cloudflare Workers](https://workers.cloudflare.com/)
- Task data from [Productive.io API](https://developer.productive.io/)
