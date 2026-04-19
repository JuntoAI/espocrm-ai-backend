# espocrm-ai-backend

AI backend service bridging Google Gemini and MCP tools for EspoCRM.

## Description

This service acts as the AI bridge between Google's Gemini models (via Vertex AI) and EspoCRM through the Model Context Protocol (MCP). It receives natural language requests from the [espocrm-ai-assistant-extension](https://github.com/JuntoAI/espocrm-ai-assistant-extension) and orchestrates CRM operations using the [espocrm-mcp-server](https://github.com/JuntoAI/espocrm-mcp-server).

## Architecture

```
EspoCRM + AI Assistant Extension → AI Backend (this repo) → MCP Server → EspoCRM API
                                        ↕
                                   Vertex AI / Gemini
```

## Prerequisites

- Node.js >= 20
- A running EspoCRM instance
- Google Cloud Platform project with Vertex AI API enabled
- A running [espocrm-mcp-server](https://github.com/JuntoAI/espocrm-mcp-server) instance

## Environment Variables

Copy `.env.example` to `.env` and configure:

| Variable | Description | Example |
|---|---|---|
| `PORT` | Server port | `3001` |
| `GOOGLE_CLOUD_PROJECT` | GCP project ID | `your-gcp-project-id` |
| `GOOGLE_CLOUD_REGION` | GCP region | `us-central1` |
| `ESPOCRM_URL` | EspoCRM instance URL | `https://crm.example.com` |
| `MCP_SERVER_PATH` | Path to MCP server | `../espocrm-mcp-server/EspoMCP/build/index.js` |

### MCP_SERVER_PATH

Controls how the backend connects to the MCP server:
- **Local path**: Relative or absolute path to your local `espocrm-mcp-server` clone. The backend spawns the MCP server as a child process.
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

| Repository | Description | Link |
|---|---|---|
| espocrm-mcp-server | MCP server for EspoCRM with 47 CRM tools | [GitHub](https://github.com/JuntoAI/espocrm-mcp-server) |
| espocrm-ai-assistant-extension | AI-powered CRM assistant extension | [GitHub](https://github.com/JuntoAI/espocrm-ai-assistant-extension) |
| espocrm-chart-dashlet-extension | Configurable pie and bar chart dashlets | [GitHub](https://github.com/JuntoAI/espocrm-chart-dashlet-extension) |
| espocrm-reporting-extension | Full-page reporting dashboard | [GitHub](https://github.com/JuntoAI/espocrm-reporting-extension) |
| espocrm-gcp-terraform | Terraform modules for deploying EspoCRM on GCP | [GitHub](https://github.com/JuntoAI/espocrm-gcp-terraform) |

## License

MIT
