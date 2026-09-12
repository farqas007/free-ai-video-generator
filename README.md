# Free AI Video Generator

A lightweight, **real** AI video generator. You type a text prompt and get an actual
generated MP4 video file back. No fake progress, no fake videos, and **no paid API**
is required by the architecture.

- Videos are generated **remotely** on a free, public **Hugging Face Gradio Space**
  that hosts an open-source text-to-video model. Nothing heavy runs locally.
- The frontend polls the backend, which reports the **real** remote job state
  (`queued -> generating -> ready | error`).
- A job is only ever reported `ready` once a real video file exists in `output/`.

## Architecture

```
 Browser (public/)
     |  POST /api/videos  +  poll GET /api/videos/:id
     v
 Express API (server.js)
     |  VideoProvider interface  (providers/video-provider.js)
     v
 HuggingFaceSpaceProvider (providers/huggingface-space-provider.js)
     |  public Gradio Queue API (REST, no key required)
     v
 public HF Space (open-source video model)
     |  real generated MP4
     v
 output/<jobId>.mp4
     |
     v
 browser <video> preview + download
```

## Setup

Requirements: Node.js 22+, internet access. No local model, no GPU needed locally,
no paid API key.

```bash
npm install
cp .env.example .env
# edit .env: set HF_SPACE_ID to a public video-generation Space you want to use
npm start
# open http://localhost:3000
```

`GET /api/health` tells you whether the provider is configured (`providerConfigured: true`)
before you try to generate.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `HF_SPACE_ID` | yes (for real generation) | Hugging Face Space id, e.g. `owner/space-name` |
| `HF_SPACE_URL` | no | Full base URL override; falls back to `https://<HF_SPACE_ID>.hf.space` |
| `HF_SPACE_API_NAME` | no | Explicit Gradio function name (e.g. `/generate`). Auto-detected from the Space's `openapi.json` when empty. |
| `HF_SPACE_TOKEN` | no | Free Hugging Face token -> better rate limits. **Backend only, never in frontend code.** |
| `HF_SPACE_TIMEOUT_MS` | no | Max wait for a generation (default `600000` ms). |
| `HF_SPACE_RETRIES` | no | Retries for transient network/rate-limit failures (default `3`). |
| `VIDEO_PROVIDER` | no | Provider to use (default `huggingface-space`). |
| `PORT` | no | HTTP port (default `3000`). |

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Server + provider status. |
| `POST /api/videos` | `{ "prompt": "..." }` -> creates a job (HTTP 201). |
| `GET /api/videos/:id` | Real job state: `queued \| generating \| ready \| error`. |
| `GET /api/videos/:id/file` | The generated MP4 (only when the job is `ready`). |

## How the provider works

1. Resolve the Space's base URL from `HF_SPACE_URL` or `https://<HF_SPACE_ID>.hf.space`.
2. Discover the callable Gradio function from the Space's public `openapi.json`
   (or use `HF_SPACE_API_NAME` if set).
3. Submit the prompt to `POST <space>/gradio_api/call/<fn>` and receive a real `event_id`.
4. Stream the Space's Server-Sent Events (`status`, `generating`, `complete`) until the
   job finishes, mapping them to real job states and messages (including real queue
   position and remote step counters when the Space reports them).
5. Download the produced video into `output/`.
6. Only then the job becomes `ready` and `/api/videos/:id/file` serves the file.

Nothing is faked: if a Space is offline, rate-limited, rejects the prompt, times out, or
returns no video URL, the job moves to `error` with the actual reason.

## Honest limitations

- **Remote, not local.** No model is downloaded or run on your machine; a GPU running the
  Space does the work. Your Chromebook only hosts the tiny Node app.
- **Community Spaces change.** Public Spaces can be offline, queued, rate-limited, or go
  Pro-only at any time. Availability and quality are **not guaranteed**. If `HF_SPACE_ID`
  becomes stale, pick another public video-generation Space from huggingface.co/spaces.
- **No paid API is required** for the architecture. Some Spaces ask for a (free) HF login or
  behave better with a free `HF_SPACE_TOKEN`.
- Output is typically a short clip (a few seconds) and depends on the chosen Space/model.
- Your prompts are sent to the public Space you configure - don't send anything sensitive.

## Adding another provider

Implement the `VideoProvider` contract in `providers/video-provider.js`:

| Method | Purpose |
|---|---|
| `generate(prompt, options)` | Start generation; return a `queued` job snapshot. |
| `getStatus(jobId)` | Return the latest job snapshot (or `null`). |
| `getResult(jobId)` | Return `{ filePath, meta }` when `ready`; throw otherwise. |
| `isConfigured()` | Whether the provider can generate right now. |

Register it in `server.js` under a key and set `VIDEO_PROVIDER` - the API and frontend
don't change.

## Not included (deliberately, for now)

Authentication, user accounts, databases, image-to-video, and text-to-speech. This is a
single-user foundation to be extended later.

## Troubleshooting

- Health shows `providerConfigured: false` -> set `HF_SPACE_ID` (or `HF_SPACE_URL`) in `.env` and restart.
- Job immediately `error` -> the Space is offline, unreachable, or using a custom API name
  (set `HF_SPACE_API_NAME`). The error message is the Space's real response.
- Generation is slow or queued -> normal for free public Spaces. The status area shows the
  real queue position / step counters when the Space reports them.