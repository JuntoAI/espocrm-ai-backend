# Per-User Knowledge Files

Each user gets a subdirectory named by their EspoCRM user ID.
Place `.md` or `.txt` files in the user's directory to inject personal context into their AI conversations.

## Example Structure

```
users/
├── 69e0ebbbb5f3b0820/          ← Markus Schmidberger's user ID
│   ├── personal-dna.md         ← Communication style, values, tone
│   └── email-preferences.md   ← How to write emails for this user
└── 69e0ec322616f062b/          ← Miriam Schmidberger's user ID
    └── personal-dna.md
```

## What to Include in personal-dna.md

- Communication style (formal/informal, direct/diplomatic)
- Values and principles
- Preferred email tone and structure
- Language preferences (German/English, when to use which)
- Signature style
- Common phrases or greetings they use
- Topics they care about
- How they want to be perceived
