/**
 * onboarding.js
 * -------------
 * Dedicated `/onboarding.html` page:
 *
 *   1. Fetch /api/voice/profile. If Instant Voice Clone isn't available,
 *      bounce back to the editor.
 *   2. Show a few spoken prompts. User hits Record once and answers them
 *      out loud in order, in ONE continuous take (same natural register
 *      throughout -- separate free-response clips used to confuse clone
 *      tone/accent consistency).
 *   3. POST that single recording to /api/voice/clone. Backend clones the
 *      voice and, in the background, transcribes the same clip to seed
 *      user_context (docs/research-roadmap.md #11).
 *   4. Navigate back to `/`.
 */

(() => {
  'use strict';

  const PROFILE_ENDPOINT = '/api/voice/profile';
  const CLONE_ENDPOINT = '/api/voice/clone';
  const SKIP_STORAGE_KEY = 'innervoice.onboardingSkipped';
  const STEP_ORDER = ['welcome', 'script'];
  const SCRIPT_SLOT = 'script';

  const stepsEl = document.getElementById('onboarding-steps');
  const promptsEl = document.getElementById('onboarding-prompts');
  const errorTextEl = document.getElementById('onboarding-error-text');

  let mediaStream = null;
  let activeRecording = null; // { recorder, chunks }
  let scriptBlob = null;
  let contextPrompts = [];

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
        (i <= idx ? 'bg-white' : 'bg-white/15');
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

  function renderPrompts() {
    promptsEl.innerHTML = '';
    contextPrompts.forEach((prompt, i) => {
      const item = document.createElement('li');
      item.className = 'rounded-lg border border-neutral-800 px-4 py-3';
      const label = document.createElement('p');
      label.className = 'text-[17px] text-neutral-100 font-serif leading-relaxed';
      label.textContent = `${i + 1}. ${prompt.label}`;
      const hint = document.createElement('p');
      hint.className = 'text-[11px] text-neutral-600 mt-1';
      hint.textContent = prompt.hint || '';
      item.appendChild(label);
      item.appendChild(hint);
      promptsEl.appendChild(item);
    });
  }

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
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    } catch (err) {
      console.warn('[InnerVoice] falling back to default audio constraints', err);
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }
    return mediaStream;
  }

  function setRecordingUi(isRecording) {
    const btn = document.querySelector('[data-step="script"] .record-btn');
    if (!btn) return;
    const label = btn.querySelector('.rec-label');
    const indicator = btn.querySelector('.rec-indicator');
    if (label) label.textContent = isRecording ? 'Stop' : 'Record';
    if (indicator) indicator.classList.toggle('animate-pulse-soft', isRecording);
  }

  function setClipStatus(text) {
    const el = document.querySelector('[data-step="script"] .clip-status');
    if (el) el.textContent = text || '';
  }

  function updateSubmitEnabled() {
    const submitBtn = document.querySelector('[data-step="script"] [data-action="submit"]');
    if (submitBtn) submitBtn.disabled = !scriptBlob;
  }

  async function toggleRecording() {
    if (activeRecording) {
      activeRecording.recorder.stop();
      return;
    }

    let stream;
    try {
      stream = await ensureMic();
    } catch (err) {
      showError("Couldn't access your microphone. Check permissions and try again.");
      return;
    }

    const mimeType = pickMimeType();
    const chunks = [];
    let recorder;
    try {
      recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
    } catch (err) {
      showError("This browser can't record audio. Try Chrome or Firefox.");
      return;
    }

    activeRecording = { recorder, chunks };
    setRecordingUi(true);
    setClipStatus('Recording… answer each prompt in order');

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    recorder.onstop = () => {
      activeRecording = null;
      setRecordingUi(false);
      const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' });
      scriptBlob = blob;
      const preview = document.querySelector('[data-step="script"] .preview-audio');
      if (preview) {
        preview.src = URL.createObjectURL(blob);
        preview.classList.remove('hidden');
      }
      setClipStatus('Saved — you can re-record if you want.');
      updateSubmitEnabled();
    };
    recorder.start();
  }

  async function submitClone() {
    if (!scriptBlob) return;
    goToStep('cloning');

    const formData = new FormData();
    formData.append('samples', scriptBlob, `${SCRIPT_SLOT}.${extensionFor(scriptBlob.type)}`);
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

  document.addEventListener('click', (e) => {
    const target = e.target.closest('[data-action]');
    if (!target) return;
    const action = target.dataset.action;

    if (action === 'record') {
      toggleRecording();
    } else if (action === 'start') {
      renderPrompts();
      goToStep('script');
    } else if (action === 'back') {
      const panel = target.closest('.onboarding-panel');
      const idx = STEP_ORDER.indexOf(panel.dataset.step);
      goToStep(STEP_ORDER[Math.max(0, idx - 1)]);
    } else if (action === 'submit') {
      submitClone();
    } else if (action === 'retry') {
      goToStep('script');
    } else if (action === 'skip') {
      localStorage.setItem(SKIP_STORAGE_KEY, '1');
      backToEditor();
    }
  });

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
      window.location.href = '/';
      return;
    }

    contextPrompts = profile.context_prompts || [];
    goToStep('welcome');
  }

  init();
})();
