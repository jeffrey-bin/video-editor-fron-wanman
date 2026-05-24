# P5 Real Media Fixtures

These fixtures are project-generated test assets for PromptCut Studio P5 media quality regression.

Generate them offline with:

```bash
npm run media:p5:generate-fixtures
```

Rules:

- Do not replace these files with user uploads, customer media, production object-store exports, or network downloads.
- The source of truth is `tests/fixtures/media/manifests/p5-real-media-fixtures.json`.
- Fixtures are intentionally small and deterministic so `ffprobe`, audio metrics, video frame metrics, and P5 smoke runs can execute in local CI.
