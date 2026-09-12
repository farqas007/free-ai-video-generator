'use strict';

const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { VideoProvider } = require('./video-provider');

/**
 * HuggingFaceSpaceProvider
 *
 * Generates REAL videos by calling a public Hugging Face Gradio Space that runs
 * an open-source text-to-video model. There is no local model and no paid API:
 * the work happens on the remote Space, exactly like it does when you open the
 * Space in a browser.
 *
 * This uses the documented Gradio "queue API" exposed by every public Space:
 *
 *   1. Discover callable function:
 *        GET  <space>/gradio_api/openapi.json
 *      (falls back to explicit HF_SPACE_API_NAME if you set it)
 *   2. Submit the job:
 *        POST <space>/gradio_api/call/<fn>
 *        body: { "data": [ "<prompt>" ] }
 *        -> { "event_id": "..." }
 *   3. Stream the result (Server-Sent Events):
 *        GET  <space>/gradio_api/call/<fn>/<event_id>
 *      emits real `status`, `generating` and `complete` events; the `complete`
 *      payload contains the generated video URL.
 *   4. Download the video into the output directory.
 *
 * Every job only reaches `ready` after a real video file exists on disk.
 * Missing/offline configuration moves the job to a truthful `error` state.
 *
 * Configuration (environment variables, all optional except the Space itself):
 *   HF_SPACE_ID          owner/space-name (e.g. "some-owner/video-space")
 *   HF_SPACE_URL         full base URL override (falls back to the id)
 *   HF_SPACE_API_NAME    explicit Gradio fn name (e.g. "/generate")
 *   HF_SPACE_TOKEN       optional free HF token (backend only)
 *   HF_SPACE_TIMEOUT_MS  max wait for a generation (default 10 minutes)
 */
class HuggingFaceSpaceProvider extends VideoProvider {
  constructor(options = {}) {
    super();
    this.name = 'huggingface-space';

    this.spaceId = String(options.spaceId || process.env.HF_SPACE_ID || '').trim();
    this.apiName = String(options.apiName || process.env.HF_SPACE_API_NAME || '').trim();
    this.spaceUrl = String(options.spaceUrl || process.env.HF_SPACE_URL || '').trim();
    this.hfToken = String(options.hfToken || process.env.HF_SPACE_TOKEN || '').trim();
    this.outputDir = path.resolve(options.outputDir || process.env.VIDEO_OUTPUT_DIR || 'output');
    this.timeoutMs = Number(options.timeoutMs || process.env.HF_SPACE_TIMEOUT_MS || 10 * 60 * 1000);

    this.fetch = options.fetch || globalThis.fetch;
    this.retryAttempts = Number(options.retryAttempts || process.env.HF_SPACE_RETRIES || 3);
    this._endpointCache = null;

    fs.mkdirSync(this.outputDir, { recursive: true });
  }

  /** Retry network steps: public Spaces often drop connections or rate-limit. */
  async _withRetries(fn, label, job, attempts = this.retryAttempts) {
    let lastErr;
    for (let i = 1; i <= attempts; i += 1) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (i >= attempts) break;
        const delay = 800 * i;
        if (job) {
          this.setState(job, 'generating', `${label} (attempt ${i}/${attempts} failed; retrying in ${delay}ms).`);
        }
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastErr;
  }

  isConfigured() {
    return Boolean(this.spaceId || this.spaceUrl);
  }

  resolvedSpaceUrl() {
    if (this.spaceUrl) return this.spaceUrl.replace(/\/+$/, '');
    if (this.spaceId) {
      // Space id "owner/name" maps to the host "owner-name.hf.space"
      const host = this.spaceId.replace(/\//g, '-');
      return `https://${host}.hf.space`;
    }
    return null;
  }

  generate(prompt, options = {}) {
    const job = this.makeJob(prompt);
    job.options = options || {};
    this.jobs.set(job.id, job);

    if (!this.isConfigured()) {
      this.markError(
        job,
        'Video provider is not configured. Set HF_SPACE_ID (or HF_SPACE_URL) in .env, then restart the server.'
      );
      return this.snapshot(job);
    }

    this._run(job).catch((err) => {
      this.markError(job, err && err.message ? err.message : String(err));
    });

    return this.snapshot(job);
  }

  getStatus(jobId) {
    const job = this.jobs.get(jobId);
    return job ? this.snapshot(job) : null;
  }

  getResult(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error('Unknown job.');
    if (job.state !== 'ready' || !job.filePath) {
      throw new Error('Job is not ready.');
    }
    return { filePath: job.filePath, meta: job.meta };
  }

  // ---- internals -----------------------------------------------------------

  headers(json = false) {
    const headers = { Accept: 'application/json' };
    if (json) headers['Content-Type'] = 'application/json';
    if (this.hfToken) headers.Authorization = `Bearer ${this.hfToken}`;
    return headers;
  }

  async _run(job) {
    const spaceUrl = this.resolvedSpaceUrl();
    const endpoint = await this._withRetries(
      () => this._resolveEndpoint(spaceUrl),
      'Reading Space API info',
      job
    );
    const sub = await this._withRetries(
      () => this._submit(spaceUrl, endpoint, [
        job.options?.inputImage ?? null,
        job.prompt,
        job.options?.aspectRatio || '832x480',
        job.options?.durationSeconds || 2
      ]),
      'Submitting prompt',
      job
    );
    const outputs = await this._awaitResult(spaceUrl, endpoint, sub, job);
    const fileUrl = this._extractVideoUrl(outputs);

    if (!fileUrl) {
      throw new Error('Remote Space finished but returned no video file URL.');
    }

    this.setState(job, 'generating', 'Downloading generated video…');
    const filePath = await this._withRetries(
      () => this._download(fileUrl, job),
      'Downloading video',
      job,
      2
    );
    const meta = {
      bytes: job._bytes,
      sizeLabel: this.formatBytes(job._bytes),
      remoteUrl: fileUrl,
      savedAt: new Date().toISOString()
    };
    job.filePath = filePath;
    job.fileUrl = fileUrl;
    this.markReady(job, filePath, meta);
  }

  /**
   * Discover the Gradio callable from the Space's public openapi.json, or fall
   * back to an explicit HF_SPACE_API_NAME. Never guesses blindly: if nothing
   * can be resolved, an error is thrown (and the job becomes `error`).
   */
  async _resolveEndpoint(spaceUrl) {
    if (this._endpointCache) return this._endpointCache;
    if (!spaceUrl) throw new Error('No Space URL configured.');

    if (this.apiName) {
      const fn = this.apiName.startsWith('/') ? this.apiName : `/${this.apiName}`;
      this._endpointCache = { path: `/gradio_api/call${fn}`, mode: 'queue' };
      return this._endpointCache;
    }

    let spec;
    try {
      const res = await this.fetch(`${spaceUrl}/gradio_api/openapi.json`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(30000)
      });
      if (!res.ok) throw new Error(`openapi.json returned HTTP ${res.status}`);
      spec = await res.json();
    } catch (err) {
      throw new Error(`Could not read the Space's openapi.json (${err.message}). ` +
        'Is the Space online? If it uses a custom API name, set HF_SPACE_API_NAME.');
    }

    const paths = Object.keys(spec.paths || {}).filter((p) => spec.paths[p].post);
    const queue = paths.find(
      (p) => /^\/gradio_api\/call\/(v2\/)?[^.]+$/.test(p) && !p.includes('_load_initial')
    );
    if (queue) {
      this._endpointCache = { path: queue.replace(/\/$/, ''), mode: 'queue' };
      return this._endpointCache;
    }

    const legacy = paths.find((p) => ['/run/predict', '/predict'].includes(p));
    if (legacy) {
      this._endpointCache = { path: legacy, mode: 'legacy' };
      return this._endpointCache;
    }

    throw new Error(
      `No callable Gradio endpoint found in ${spaceUrl}/gradio_api/openapi.json. ` +
      'Set HF_SPACE_API_NAME to the function this Space exposes.'
    );
  }

  async _submit(spaceUrl, endpoint, args) {
    const res = await this.fetch(`${spaceUrl}${endpoint.path}`, {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify({ data: args }),
      signal: AbortSignal.timeout(30000)
    });
    if (!res.ok) {
      throw new Error(`Space call failed: HTTP ${res.status} - ${await this._shortBody(res)}`);
    }
    let body;
    try {
      body = await res.json();
    } catch {
      throw new Error('Space returned a non-JSON response to the call request.');
    }

    if (endpoint.mode === 'legacy') {
      if (body === null || body.data === undefined) {
        throw new Error('Space responded without output data.');
      }
      return { eventId: null, outputs: body.data };
    }

    if (typeof body.event_id === 'string' && body.event_id) {
      return { eventId: body.event_id, outputs: null };
    }
    if (body.data !== undefined) {
      return { eventId: null, outputs: body.data };
    }
    throw new Error(`Unexpected Space response (no event_id): ${JSON.stringify(body).slice(0, 200)}`);
  }

  async _awaitResult(spaceUrl, endpoint, sub, job) {
    if (!sub.eventId) {
      if (sub.outputs !== undefined && sub.outputs !== null) return sub.outputs;
      throw new Error('Space returned a result with no output data.');
    }
    this.setState(job, 'generating', 'Waiting in Space queue…');
    return this._readSse(`${spaceUrl}${endpoint.path}/${sub.eventId}`, job);
  }

  /** Read the Space's Server-Sent Events stream until `complete` or `error`. */
  async _readSse(url, job) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetch(url, { headers: this.headers(), signal: controller.signal });
      if (!res.ok) {
        throw new Error(`Space result stream returned HTTP ${res.status} - ${await this._shortBody(res)}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let sep;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const rawEvent = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const parsed = this._parseSse(rawEvent);
          if (!parsed) continue;
          if (parsed.event === 'complete') return parsed.data;
          if (parsed.event === 'error') {
            throw new Error(this._sseError(parsed.data));
          }
          if (parsed.event === 'status') this._applyStatus(parsed.data, job);
          if (parsed.event === 'generating') this._applyProgress(parsed.data, job);
        }
      }
      throw new Error('Space stream ended before a result was received.');
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new Error(`Generation timed out after ${Math.round(this.timeoutMs / 1000)}s.`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  _parseSse(raw) {
    let event = 'message';
    const dataLines = [];
    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) return null;
    let data;
    try {
      data = JSON.parse(dataLines.join('\n'));
    } catch {
      data = dataLines.join('\n');
    }
    return { event, data };
  }

  _applyStatus(data, job) {
    if (!data || typeof data !== 'object') return;
    if (typeof data.queue_position === 'number') {
      this.setState(job, 'generating', `Waiting in Space queue (position ${data.queue_position}).`);
    } else if (data.stage === 'generating') {
      this.setState(job, 'generating', 'Generating on remote Space…');
    }
  }

  /** Real step counters reported by the remote Space (not fabricated locally). */
  _applyProgress(data, job) {
    const pd = data && Array.isArray(data.progress_data) ? data.progress_data : [];
    const p = pd.find((x) => x && typeof x.index === 'number' && typeof x.length === 'number');
    if (p) {
      this.setState(
        job,
        'generating',
        `Generating on remote Space… (step ${p.index}/${p.length}${p.unit ? ' ' + p.unit : ''})`
      );
    }
  }

  _sseError(data) {
    const msg = data && data.error ? data.error : JSON.stringify(data);
    return `Space returned an error: ${String(msg).slice(0, 300)}`;
  }

  async _shortBody(res) {
    try {
      return (await res.text()).slice(0, 300);
    } catch {
      return '';
    }
  }

  /** Recursively find a video file URL inside the Space's response data. */
  _extractVideoUrl(node, depth = 0) {
    if (depth > 6) return null;
    if (typeof node === 'string') {
      return this._normFileUrl(node);
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        const hit = this._extractVideoUrl(item, depth + 1);
        if (hit) return hit;
      }
      return null;
    }
    if (node && typeof node === 'object') {
      if (node.video) {
        const hit = this._extractVideoUrl(node.video, depth + 1);
        if (hit) return hit;
      }
      if (node.url) {
        const hit = this._extractVideoUrl(node.url, depth + 1);
        if (hit) return hit;
      }
    }
    return null;
  }

  _normFileUrl(url) {
    const looks = /\.(mp4|webm|mov|mkv|m4v|ogg|gif)(\?|$)/i;
    const usesFileParam = /^file=/.test(url) || /(\/|\?)(file)=/.test(url);
    if (!url || (typeof url !== 'string') || (!looks.test(url) && !usesFileParam)) return null;
    if (/^https?:\/\//i.test(url)) return url;
    if (url.startsWith('/')) {
      const base = this.resolvedSpaceUrl();
      return base ? `${base}${url}` : null;
    }
    return url;
  }

  async _download(fileUrl, job) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetch(fileUrl, {
        headers: this.hfToken ? { Authorization: `Bearer ${this.hfToken}` } : {},
        signal: controller.signal
      });
      if (!res.ok) throw new Error(`Failed to download video: HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0) throw new Error('Downloaded video file is empty.');
      const ext = this._extForUrl(fileUrl) || '.mp4';
      const filePath = path.join(this.outputDir, `${job.id}${ext}`);
      await fsp.writeFile(filePath, buf);
      job._bytes = buf.length;
      return filePath;
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new Error(`Download of the generated video timed out after ${Math.round(this.timeoutMs / 1000)}s.`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  _extForUrl(url) {
    const m = /\.(mp4|webm|mov|mkv|m4v|ogg|gif)(\?|$)/i.exec(url || '');
    return m ? `.${m[1].toLowerCase()}` : null;
  }
}

module.exports = { HuggingFaceSpaceProvider };