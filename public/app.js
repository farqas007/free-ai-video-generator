'use strict';

(function () {
  const POLL_MS = 2000;
  const MAX_POLL_MS = 10 * 60 * 1000;

  const els = {
    prompt: document.getElementById('prompt'),
    chars: document.getElementById('chars'),
    aspectRatio: document.getElementById('aspectRatio'),
    duration: document.getElementById('duration'),
    generate: document.getElementById('generate'),
    health: document.getElementById('health'),
    statusCard: document.getElementById('statusCard'),
    statusBadge: document.getElementById('statusBadge'),
    statusLabel: document.getElementById('statusLabel'),
    statusMsg: document.getElementById('statusMsg'),
    errorCard: document.getElementById('errorCard'),
    errorMsg: document.getElementById('errorMsg'),
    resultCard: document.getElementById('resultCard'),
    preview: document.getElementById('preview'),
    download: document.getElementById('download'),
    fileInfo: document.getElementById('fileInfo'),
    resultMeta: document.getElementById('resultMeta'),
    emptyState: document.getElementById('emptyState'),
    examples: Array.from(document.querySelectorAll('.example'))
  };

  let activeJob = null;
  let pollTimer = null;
  let pollSince = 0;
  let lastOptions = { aspectRatio: '832x480', durationSeconds: 2 };

  const STATE_LABEL = {
    queued: 'Queued',
    generating: 'Generating',
    ready: 'Done',
    error: 'Failed'
  };

  els.prompt.addEventListener('input', setChars);

  function setChars() {
    els.chars.textContent = `${els.prompt.value.length} / ${els.prompt.maxLength}`;
  }
  setChars();

  els.generate.addEventListener('click', () => {
    const prompt = els.prompt.value.trim();
    if (!prompt) {
      showError('Please enter a text prompt first.');
      return;
    }
    submitPrompt(prompt, els.aspectRatio.value, Number(els.duration.value));
  });

  els.examples.forEach((btn) => {
    btn.addEventListener('click', () => {
      const examplePrompt = (btn.dataset && btn.dataset.prompt) || '';
      if (!examplePrompt) return;
      els.prompt.value = examplePrompt;
      setChars();
      els.prompt.classList.add('flash');
      els.prompt.focus();
      window.setTimeout(() => els.prompt.classList.remove('flash'), 700);
    });
  });

  async function refreshHealth() {
    try {
      const res = await fetch('/api/health');
      const data = await res.json();
      const configured = data.providerConfigured === true;
      els.health.innerHTML =
        `<b style="color:${configured ? 'var(--ok)' : 'var(--warn)'}">${configured ? 'online' : 'not configured'}</b>` +
        ` &middot; ${escapeHtml(data.provider)}`;
      els.health.title = configured
        ? 'Provider configured and ready to generate.'
        : 'Set HF_SPACE_ID in .env and restart the server.';
    } catch {
      els.health.innerHTML = '<b style="color:var(--err)">offline</b>';
    }
  }

  async function submitPrompt(prompt, aspectRatio, durationSeconds) {
    stopPolling();
    hide('errorCard');
    hide('resultCard');
    hide('emptyState');
    lastOptions = { aspectRatio, durationSeconds };

    try {
      const res = await fetch('/api/videos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          aspect_ratio: aspectRatio,
          duration_seconds: durationSeconds
        })
      });
      const data = await res.json();
      if (!res.ok) {
        showError(data.error || `Server returned HTTP ${res.status}.`);
        return;
      }
      activeJob = data;
      pollSince = Date.now();
      renderStatus(data);
      startPolling();
    } catch (err) {
      showError(`Could not reach the server: ${err.message}`);
    }
  }

  function startPolling() {
    pollTimer = setInterval(poll, POLL_MS);
  }

  async function poll() {
    if (!activeJob) return;
    try {
      const res = await fetch(`/api/videos/${activeJob.id}`);
      if (res.status === 404) {
        showError('This job no longer exists on the server. Try generating again.');
        stopPolling();
        return;
      }
      const data = await res.json();
      activeJob = data;
      renderStatus(data);

      if (data.state === 'ready' || data.state === 'error') {
        stopPolling();
      } else if (Date.now() - pollSince > MAX_POLL_MS) {
        showError('Generation took too long and was stopped. The Space may be busy or down; try again later.');
        stopPolling();
      }
    } catch (err) {
      showError(`Polling failed: ${err.message}`);
      stopPolling();
    }
  }

  function renderStatus(job) {
    hide('errorCard');
    show('statusCard');

    els.statusBadge.textContent = job.state;
    els.statusBadge.className = `badge ${job.state}`;
    els.statusLabel.textContent = STATE_LABEL[job.state] || job.state;

    const msg = job.state === 'queued' && !job.message ? 'Queued.' : job.message;
    els.statusMsg.textContent = msg || '';

    els.statusCard.classList.toggle('working', job.state === 'queued' || job.state === 'generating');
    els.statusCard.dataset.state = job.state;

    if (job.state === 'ready') {
      renderReady(job);
    }
    if (job.state === 'error') {
      showError(job.error || job.message || 'The video provider reported a problem.');
    }
  }

  function renderReady(job) {
    hide('statusCard');
    show('resultCard');

    els.preview.src = `/api/videos/${job.id}/file`;
    els.preview.load();
    els.download.href = `/api/videos/${job.id}/file`;
    els.download.setAttribute('download', `generated-${job.id}.mp4`);

    const meta = job.meta || {};
    const metaParts = [`Requested: ${lastOptions.aspectRatio || '832x480'} · ${lastOptions.durationSeconds || 2}s`];
    if (meta.sizeLabel) metaParts.push(meta.sizeLabel);
    els.resultMeta.textContent = metaParts.join(' · ');
    els.fileInfo.textContent = 'real MP4, generated by the model';
  }

  function showError(message) {
    hide('statusCard');
    hide('resultCard');
    show('errorCard');
    show('emptyState');
    els.errorMsg.textContent = message || 'Unknown error.';
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  function show(id) { els[id].hidden = false; }
  function hide(id) { els[id].hidden = true; }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  refreshHealth();
  setInterval(refreshHealth, 30000);
})();