# espocrm-ai-backend

AI backend service bridging Google Gemini (via Vertex AI) and EspoCRM through the Model Context Protocol (MCP). Receives natural language requests from the AI Assistant extension and orchestrates CRM operations using 47 MCP tools.

Built by [JuntoAI](https://juntoai.org) — the next generation business network.

## Architecture

```
┌──────────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│ EspoCRM +            │────▶│ AI Backend       │────▶│ MCP Server      │
│ AI Assistant         │◀────│ (this repo)      │◀────│ (47 CRM tools)  │
│ Extension            │     │                  │     └────────┬────────┘
└──────────────────────┘     │ Vertex AI /      │              │
                             │ Gemini           │              ▼
                             └──────────────────┘       EspoCRM REST API
```

## Prerequisites

- Node.js >= 20
- A running EspoCRM instance with API access
- Google Cloud Platform project with Vertex AI API enabled

### Required dependencies

- **[espocrm-mcp-server](https://github.com/JuntoAI/espocrm-mcp-server)** — provides the 47 CRM tools this backend uses

### Consumed by

- **[espocrm-ai-assistant-extension](https://github.com/JuntoAI/espocrm-ai-assistant-extension)** — the EspoCRM extension that calls this backend

**Deployment order:** MCP Server → AI Backend → AI Assistant Extension

## Environment Variables

Copy `.env.example` to `.env` and configure:

| Variable | Description | Example |
|---|---|---|
| `PORT` | Server port | `3001` |
| `GOOGLE_CLOUD_PROJECT` | GCP project ID | `your-gcp-project-id` |
| `GOOGLE_CLOUD_REGION` | GCP region | `us-central1` |
| `ESPOCRM_URL` | EspoCRM instance URL | `https://crm.example.com` |
| `MCP_SERVER_PATH` | Path to MCP server build | `../espocrm-mcp-server/EspoMCP/build/index.js` |
| `GEMINI_DEFAULT_MODEL` | Default Gemini model | `gemini-3.1-flash-lite-preview` |

### MCP_SERVER_PATH

Controls how the backend connects to the MCP server:
- **Local path**: Point to your local `espocrm-mcp-server` clone (e.g., `../espocrm-mcp-server/EspoMCP/build/index.js`). The backend spawns the MCP server as a child process.
- **Remote URL**: URL of a running MCP server instance for remote operation.

## Local Development

```bash
npm install
cp .env.example .env
# Edit .env with your values
npm run dev
```

## Docker

```bash
docker build -t espocrm-ai-backend .
docker run -p 3001:3001 --env-file .env espocrm-ai-backend
```

## Testing

```bash
npm test                    # all tests
npm run test:unit           # unit tests
npm run test:properties     # property-based tests
npm run test:integration    # integration tests (requires running EspoCRM + MCP)
```

## API

- `POST /api/chat` — Send a natural language message, receive an AI-generated response with CRM actions

## Related Repositories

This service is part of the [JuntoAI EspoCRM ecosystem](https://github.com/JuntoAI/espocrm-workspace).

| Repository | Description | Dependency |
|---|---|---|
| [espocrm-mcp-server](https://github.com/JuntoAI/espocrm-mcp-server) | MCP server with 47 CRM tools | **Required** — this backend calls the MCP server |
| [espocrm-ai-assistant-extension](https://github.com/JuntoAI/espocrm-ai-assistant-extension) | AI chat assistant for EspoCRM | **Depends on this** — the extension calls this backend |
| [espocrm-chart-dashlet-extension](https://github.com/JuntoAI/espocrm-chart-dashlet-extension) | Pie and bar chart dashlets | Independent |
| [espocrm-reporting-extension](https://github.com/JuntoAI/espocrm-reporting-extension) | Full-page reporting dashboard | Independent |
| [espocrm-gcp-terraform](https://github.com/JuntoAI/espocrm-gcp-terraform) | Terraform modules for deploying EspoCRM on GCP | Independent |

## About JuntoAI

[JuntoAI](https://juntoai.org) is the next generation business network. We use EspoCRM as our CRM and share our extensions with the community as open source.

Join the waitlist at [juntoai.org](https://juntoai.org). Found a bug? [Open an issue](https://github.com/JuntoAI/espocrm-ai-backend/issues) or reach out at [juntoai.org](https://juntoai.org).

## License

MIT
