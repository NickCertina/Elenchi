# Privacy & Retention Policy

## 1. Custom System Prompts

- **Default Non-Persistence:** Custom prompts submitted to `POST /api/runs` are hashed (`keccak256` with domain separator `elenchi-policy-v1`) into `policyHash` and discarded from persistent storage immediately after the evaluation completes.
- **Optional 24-Hour Encrypted Retention:** If the user explicitly checks `persistPrompt = true` to enable server-side prompt patching (`POST /api/runs/:id/patch`), the prompt is encrypted at rest using WebCrypto **AES-256-GCM** with a random 96-bit IV and automatically purged after 24 hours (`PROMPT_RETENTION_HOURS=24`).
- **Secret Hygiene:** Users are warned in the UI and documentation never to paste private keys, seed phrases, bearer tokens, or production credentials into custom prompts.

## 2. Session Isolation & Instant Purge

- Every evaluation defaults to `publicOptIn = false` and is scoped to an `HttpOnly`, `SameSite=Lax` HMAC-SHA256 signed session cookie (`elenchi_sid`).
- Non-owner requests to private runs receive `403 FORBIDDEN`. Even when `publicOptIn = true`, raw custom prompts remain redacted in public reports.
- Calling `DELETE /api/runs/:id` (or clicking **Purge Run Data** in `/arena`) immediately deletes the run summary and any encrypted prompt ciphertext from SQLite storage.

## 3. Model Provider Disclosure

Live sandbox runs transmit the active policy prompt and synthetic scenario fixture to the configured server-side LLM inference provider (Cloudflare Workers AI or OpenRouter/OpenAI) to generate Challenger and Defender turns.
