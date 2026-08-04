# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added — Voice/Audio Message Support (2026-08-05)

- **Audio understanding via Gemini**: Voice messages from Facebook Messenger are now processed using the same `gemini-2.0-flash` model — no new model, no new API, no additional cost.
- **`describeAudio()` in `gemini.js`**: Fetches voice message audio, sends to Gemini with a prompt to extract 2-3 product search keywords (e.g. "red saree", "gold necklace"). Returns empty string on failure, mirroring `describeImage()`.
- **Generic media fetcher**: Renamed `fetchImageAsInlineData` → `fetchMediaAsInlineData` — now handles any media type (image, audio, etc.) with appropriate mime type detection.
- **Audio in `getAIReply()`**: New optional `audioUrl` parameter. When present, audio is inlined as a Gemini part alongside text/image, with a Bengali context hint `[কাস্টমার একটি ভয়েস মেসেজ পাঠিয়েছেন]`.
- **Audio in `messageHandler.js`**: Extracts `audioUrl` from Messenger attachments (same pattern as `imageUrl`), passes through to `searchProducts()` and `getAIReply()`.
- **Audio-triggered product search**: Product search now triggers on `audioUrl` presence. When triggered purely by audio, `describeAudio()` output is used as search keywords (mirroring the image flow).
- **Conversation history**: Audio messages are logged in history as `[ভয়েস মেসেজ পাঠিয়েছে]` (mirroring `[ছবি পাঠিয়েছে]` for images).
- **Logging**: Added `🎤 [Gemini Audio]` log style for audio processing visibility in Render logs.

### Fixed — Model Configuration Conflict

- **`gemini-3.5-flash-lite` blocked**: The `.env` defaulted to `gemini-3.5-flash-lite`, but this model is in `BLOCKED_MODELS` and was silently overridden to `gemini-2.0-flash` at startup. This is now documented as expected behavior.

### Files Modified

- `src/services/gemini.js` — Generic media fetcher, `describeAudio()`, `getAIReply(audioUrl)`
- `src/services/ai.js` — Wrapper passes `audioUrl` through, exports `describeAudio`
- `src/services/productSearch.js` — Accepts `audioUrl`, triggers audio keyword extraction
- `src/services/messageHandler.js` — Extracts audio attachments, passes through pipeline, updates history

### Test Suggestion

Send a short voice message via Messenger asking about a product (e.g. "I want a red saree"). Confirm in Render logs that:
1. `🎤 [Gemini Audio] Analyzing voice message:` appears
2. `🎯 [Gemini Audio] Identified search keywords:` returns relevant terms
3. Bot replies with matching products

If Gemini rejects the audio format, check the logged `content-type` header — the mimeType may need adjustment for Facebook's audio encoding.
