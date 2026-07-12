/**
 * onboarding.js
 * -------------
 * Script for the dedicated `/onboarding.html` page (a real page navigation,
 * not a popup/overlay on top of the editor):
 *
 *   1. Fetch /api/voice/profile. If Instant Voice Clone isn't available,
 *      bounce straight back to the editor -- nothing to do here.
 *   2. Read a short script out loud (MediaRecorder), then answer a few
 *      "get to know you" prompts out loud.
 *   3. POST all recordings to /api/voice/clone. The backend runs ElevenLabs
 *      Instant Voice Clone, persists the resulting voice_id, and every
 *      subsequent /api/predict whisper uses it automatically.
 *   4. Navigate back to `/` -- the editor's own boot check (voice-gate.js)
 *      sees the voice is now set and just lets the normal typing/whisper
 *      loop run.
 */

(() => {
  'use strict';

  const PROFILE_ENDPOINT = '/api/voice/profile';
  const CLONE_ENDPOINT = '/api/voice/clone';
  const SKIP_STORAGE_KEY = 'innervoice.onboardingSkipped';
  const STEP_ORDER = ['welcome', 'script', 'personality'];

  const stepsEl = document.getElementById('onboarding-steps');
  const scriptTextEl = document.getElementById('onboarding-script-text');
  const promptsContainer = document.getElementById('onboarding-prompts');
  const errorTextEl = document.getElementById('onboarding-error-text');

  let mediaStream = null;
  let activeRecording = null; // { slot, recorder, chunks }
  const recordings = new Map(); // slot -> Blob

  // -----------------------------------------------------------------------
  // Step navigation
  // -----------------------------------------------------------------------
  function renderStepDots(current) {
    stepsEl.innerHTML = '';
    const idx = STEP_ORDER.indexOf(current);
    if (idx === -1) {
      stepsEl.classList.add('hidden');
      return;
    }
    stepsEl.classList.remove('hidden');
    STEP_ORDER.forEach((_, i) => {
      const dot = document.createElement('span');
      dot.className =
        'w-1.5 h-1.5 rounded-full transition-colors ' +
        (i <= idx ? 'bg-[#e5c98f]' : 'bg-white/15');
      stepsEl.appendChild(dot);
    });
  }

  function goToStep(step) {
    document.querySelectorAll('.onboarding-panel').forEach((panel) => {
      panel.classList.toggle('hidden', panel.dataset.step !== step);
    });
    renderStepDots(step);
  }

  function backToEditor() {
    releaseMic();
    window.location.href = '/';
  }

  // -----------------------------------------------------------------------
  // Recording
  // -----------------------------------------------------------------------
  function pickMimeType() {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4',
      'audio/ogg;codecs=opus',
    ];
    if (!window.MediaRecorder) return '';
    return candidates.find((c) => MediaRecorder.isTypeSupported(c)) || '';
  }

  function extensionFor(mimeType) {
    if (mimeType.includes('webm')) return 'webm';
    if (mimeType.includes('mp4')) return 'm4a';
    if (mimeType.includes('ogg')) return 'ogg';
    return 'audio';
  }

  function releaseMic() {
    if (activeRecording) {
      try {
        activeRecording.recorder.stop();
      } catch {
        /* no-op */
      }
      activeRecording = null;
    }
    if (mediaStream) {
      mediaStream.getTracks().forEach((track) => track.stop());
      mediaStream = null;
    }
  }

  async function ensureMic() {
    if (mediaStream) return mediaStream;
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    return mediaStream;
  }

  function findRecordButton(slot) {
    return document.querySelector(`.record-btn[data-slot="${slot}"]`);
  }

  function setClipStatus(slot, message) {
    const btn = findRecordButton(slot);
    const status =
      btn?.closest('[data-slot-wrap]')?.querySelector('.clip-status') ||
      btn?.parentElement?.parentElement?.querySelector('.clip-status');
    if (status) status.textContent = message;
  }

  function updatePreview(slot, blob) {
    const btn = findRecordButton(slot);
    const scope = btn?.closest('[data-slot-wrap]') || btn?.parentElement?.parentElement;
    const audioEl = scope?.querySelector('.preview-audio');
    if (audioEl) {
      audioEl.src = URL.createObjectURL(blob);
      audioEl.classList.remove('hidden');
    }
  }

  async function toggleRecording(slot, btn) {
    if (activeRecording && activeRecording.slot === slot) {
      activeRecording.recorder.stop();
      return;
    }
    if (activeRecording) return; // another recording already in progress

    let stream;
    try {
      stream = await ensureMic();
    } catch (err) {
      console.warn('[InnerVoice] mic permission denied', err);
      setClipStatus(slot, "Couldn't access your microphone -- check browser permissions.");
      return;
    }

    const mimeType = pickMimeType();
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    const chunks = [];

    recorder.addEventListener('dataavailable', (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    });

    recorder.addEventListener('stop', () => {
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      recordings.set(slot, blob);
      activeRecording = null;
      setRecordButtonState(btn, 'idle');
      setClipStatus(slot, 'Saved — you can re-record if you want.');
      updatePreview(slot, blob);
      refreshNextButtons();
    });

    recorder.start();
    activeRecording = { slot, recorder, chunks };
    setRecordButtonState(btn, 'recording');
    setClipStatus(slot, 'Recording… click again to stop.');
  }

  function setRecordButtonState(btn, state) {
    if (!btn) return;
    const label = btn.querySelector('.rec-label');
    const dot = btn.querySelector('.rec-indicator');
    if (state === 'recording') {
      label.textContent = 'Stop';
      dot.classList.add('animate-pulse-soft');
    } else {
      label.textContent = recordings.has(btn.dataset.slot) ? 'Re-record' : 'Record';
      dot.classList.remove('animate-pulse-soft');
    }
  }

  function refreshNextButtons() {
    const scriptNext = document.querySelector('[data-step="script"] [data-action="next"]');
    if (scriptNext) scriptNext.disabled = !recordings.has('script');
  }

  // -----------------------------------------------------------------------
  // Personality prompts (rendered dynamically from the backend's copy)
  // -----------------------------------------------------------------------
  function renderPersonalityPrompts(prompts) {
    promptsContainer.innerHTML = '';
    prompts.forEach((prompt, i) => {
      const slot = `personality-${i}`;
      const wrap = document.createElement('div');
      wrap.dataset.slotWrap = '';
      wrap.className = 'py-4 space-y-2 first:pt-0 last:pb-0';
      wrap.innerHTML = `
        <p class="text-sm text-neutral-300">${prompt}</p>
        <div class="flex items-center gap-3">
          <button data-action="record" data-slot="${slot}" class="record-btn flex items-center gap-2 text-xs text-neutral-400 hover:text-neutral-200 transition-colors">
            <span class="rec-indicator w-1.5 h-1.5 rounded-full bg-red-500"></span>
            <span class="rec-label">Record</span>
          </button>
          <audio class="preview-audio hidden" controls style="height: 26px;"></audio>
        </div>
        <p class="clip-status text-[11px] text-neutral-500 h-4"></p>
      `;
      promptsContainer.appendChild(wrap);
    });
  }

  // -----------------------------------------------------------------------
  // Submission
  // -----------------------------------------------------------------------
  async function submitClone() {
    goToStep('cloning');

    const formData = new FormData();
    for (const [slot, blob] of recordings.entries()) {
      formData.append('samples', blob, `${slot}.${extensionFor(blob.type)}`);
    }
    formData.append('voice_name', 'My InnerVoice');

    let response;
    try {
      response = await fetch(CLONE_ENDPOINT, { method: 'POST', body: formData });
    } catch (err) {
      showError('Something went wrong reaching the server. Check your connection and try again.');
      return;
    }

    if (!response.ok) {
      let message = `Voice cloning failed (${response.status}).`;
      try {
        const body = await response.json();
        message = body.detail || message;
      } catch {
        /* no-op */
      }
      showError(message);
      return;
    }

    localStorage.removeItem(SKIP_STORAGE_KEY);
    goToStep('done');
    setTimeout(() => backToEditor(), 1400);
  }

  function showError(message) {
    errorTextEl.textContent = message;
    goToStep('error');
  }

  // -----------------------------------------------------------------------
  // Wiring
  // -----------------------------------------------------------------------
  document.addEventListener('click', (e) => {
    const target = e.target.closest('[data-action]');
    if (!target) return;
    const action = target.dataset.action;

    if (action === 'record') {
      toggleRecording(target.dataset.slot, target);
    } else if (action === 'start') {
      goToStep('script');
    } else if (action === 'next') {
      goToStep(target.dataset.target);
    } else if (action === 'back') {
      const panel = target.closest('.onboarding-panel');
      const idx = STEP_ORDER.indexOf(panel.dataset.step);
      goToStep(STEP_ORDER[Math.max(0, idx - 1)]);
    } else if (action === 'submit') {
      submitClone();
    } else if (action === 'retry') {
      goToStep('personality');
    } else if (action === 'skip') {
      localStorage.setItem(SKIP_STORAGE_KEY, '1');
      backToEditor();
    }
  });

  // -----------------------------------------------------------------------
  // Boot
  // -----------------------------------------------------------------------
  async function init() {
    let profile;
    try {
      const response = await fetch(PROFILE_ENDPOINT);
      if (!response.ok) throw new Error(`profile fetch failed: ${response.status}`);
      profile = await response.json();
    } catch (err) {
      console.warn('[InnerVoice] could not load voice profile', err);
      window.location.href = '/';
      return;
    }

    if (!profile.supported) {
      window.location.href = '/'; // nothing to onboard into; bounce back.
      return;
    }

    scriptTextEl.textContent = profile.reading_script;
    renderPersonalityPrompts(profile.personality_prompts || []);
    goToStep('welcome');
  }

  init();
})();
