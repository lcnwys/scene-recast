# Contributing

Thanks for helping improve this project.

## Before you start

- Open an issue for a substantial change so the scope can be discussed.
- Do not include API keys, private media, transcripts, diagnostic exports, or generated output in issues or pull requests.
- Keep the app local-only unless a separately reviewed design adds authentication and deployment safeguards.

## Development

- Use Node.js 22.5 or newer.
- Install FFmpeg and FFprobe for media-related manual checks.
- Run `npm test` before opening a pull request.
- Do not run tests against a real ElevenLabs account unless a test specifically requires it and you understand the potential charges.

## Pull requests

- Explain the behavior change and how you checked it.
- Add or update automated tests for code changes.
- Keep changes focused and avoid committing generated media or local configuration.
