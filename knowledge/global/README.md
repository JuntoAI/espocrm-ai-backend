# Global Knowledge Files

Place `.md` or `.txt` files here to inject persistent context into ALL AI conversations.

These files are loaded at startup and refreshed every 5 minutes.
No restart needed — just drop files here and wait.

## What to Put Here

- Company pitch deck (as markdown)
- Investment criteria
- Product overview
- Team bios
- Competitive landscape
- Any information the AI should always know about JuntoAI

## Limits

- Max 500 KB per file
- Max 100,000 characters total across all global files
- Supported formats: `.md`, `.txt`
- For PDFs: extract text to `.md` first (the AI can't read raw PDFs from here)

## File Naming

Use descriptive kebab-case names. Files are sorted alphabetically and included in that order:
- `01-company-overview.md` (loaded first)
- `02-investment-criteria.md`
- `03-product-details.md`
