'use strict';

const { randomUUID } = require('crypto');

/**
 * VideoProvider - replaceable interface for REAL video generation backends.
 *
 * A provider turns a user prompt into an actual generated video file saved on
 * disk. It must never fabricate success:
 *   - it must not invent progress numbers,
 *   - it must not report "ready" without a real file,
 *   - it must move a job to "error" (with a truthful message) when generation
 *     cannot complete.
 *
 * Job state machine (single, shared across all providers):
 *
 *   queued -> generating -> ready
 *                     \--> error
 *
 * Contract:
 *   generate(prompt, options) -> job snapshot (state: 'queued' or 'error')
 *   getStatus(jobId)          -> latest job snapshot or null
 *   getResult(jobId)          -> { filePath, meta } or throws if not ready
 *   isConfigured()            -> boolean, can this provider generate right now?
 *
 * A provider owns its storage of results (e.g. an output/ directory) and knows
 * where each finished video lives.
 */
class VideoProvider {
  constructor() {
    this.name = 'abstract';
    this.jobs = new Map();
  }

  /**
   * Start generating a video from a prompt. Returns a snapshot immediately.
   * Work continues asynchronously; poll getStatus(jobId) for the real state.
   */
  generate(_prompt, _options) {
    throw new Error('VideoProvider.generate() is not implemented.');
  }

  /**
   * Return the latest snapshot for a job id (or null when unknown).
   */
  getStatus(_jobId) {
    throw new Error('VideoProvider.getStatus() is not implemented.');
  }

  /**
   * Return { filePath, meta } for a job that is 'ready'. Throws otherwise.
   */
  getResult(_jobId) {
    throw new Error('VideoProvider.getResult() is not implemented.');
  }

  /**
   * Whether the provider can generate real videos right now
   * (e.g. required configuration is present).
   */
  isConfigured() {
    return false;
  }

  /** Generate a unique job id. */
  makeId() {
    return randomUUID();
  }

  /** Build a fresh job record in the 'queued' state. */
  makeJob(prompt) {
    const now = new Date().toISOString();
    return {
      id: this.makeId(),
      provider: this.name,
      state: 'queued',
      message: 'Queued.',
      error: null,
      prompt,
      createdAt: now,
      updatedAt: now,
      fileUrl: null,
      videoUrl: null,
      meta: null
    };
  }

  /** Public, serializable snapshot of a job record. */
  snapshot(job) {
    return {
      id: job.id,
      provider: job.provider,
      state: job.state,
      message: job.message,
      error: job.error,
      prompt: job.prompt,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      fileUrl: job.fileUrl,
      videoUrl: job.state === 'ready' ? `/api/videos/${job.id}/file` : null,
      meta: job.meta
    };
  }

  setState(job, state, message) {
    if (job.state === 'ready') return;
    job.state = state;
    job.message = message || null;
    if (state === 'error') job.error = message || 'Generation failed.';
    job.updatedAt = new Date().toISOString();
  }

  markReady(job, filePath, meta) {
    job.state = 'ready';
    job.message = 'Video ready.';
    job.error = null;
    job.meta = meta;
    job.updatedAt = new Date().toISOString();
  }

  markError(job, message) {
    this.setState(job, 'error', message);
  }

  formatBytes(bytes) {
    if (typeof bytes !== 'number' || bytes < 0) return null;
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let n = bytes;
    while (n >= 1024 && i < units.length - 1) {
      n /= 1024;
      i += 1;
    }
    return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }
}

module.exports = { VideoProvider };