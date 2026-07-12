/**
 * onboarding.js
 * -------------
 * One-time (or redo-able) voice setup flow:
 *
 *   1. Fetch /api/voice/profile to find out whether Instant Voice Clone is
 *      available and whether the user already has a cloned voice.
 *   2. If not, show an overlay: read a short script + answer a few
 *      "get to know you" prompts out loud (MediaRecorder), optionally type
 *      a one-line "writing tone" note.
 *   3. POST all recordings to /api/voice/clone. The backend runs ElevenLabs
 *      Instant Voice Clone, persists the resulting voice_id, and every
 *      subsequent /api/predict whisper uses it automatically.
 *   4. Close the overlay and let `app.js`'s normal typing/whisper loop
 *      resume -- this file never touches the editor directly.
 */

(() => {
  'use strict';

  const PROFILE_ENDPOINT = '/api/voice/profile';
  const CLONE_ENDPOINT = '/api/voice/clone';
  const SKIP_STORAGE_KEY = 'innervoice.onboardingSkipped';
  const STEP_ORDER = ['welcome', 'script', 'personality', 'tone'];

  const overlay = document.getElementById('onboarding');
  const stepsEl = document.getElementById('onboarding-steps');
  const setupBtn = document.getElementById('setup-voice-btn');
  const scriptTextEl = document.getElementById('onboarding-script-text');
  const promptsContainer = document.getElementById('onboarding-prompts');
  const toneInput = document.getElementById('onboarding-tone-input');
  const errorTextEl = document.getElementById('onboarding-error-text');
  const editorEl = document.getElementById('editor');

  if (!overlay) return; // markup missing; nothing to wire up.

  let profileData = null;
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
    overlay.querySelectorAll('.onboarding-panel').forEach((panel) => {
      panel.classList.toggle('hidden', panel.dataset.step !== step);
    });
    renderStepDots(step);
  }

  function openOverlay() {
    overlay.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    // The <textarea> has `autofocus`; disable it while onboarding is up so
    // stray keystrokes can't trigger predictions underneath the overlay.
    if (editorEl) {
      editorEl.blur();
      editorEl.disabled = true;
    }
    goToStep('welcome');
  }

  function closeOverlay() {
    overlay.classList.add('hidden');
    document.body.style.overflow = '';
    releaseMic();
    if (editorEl) {
      editorEl.disabled = false;
      editorEl.focus();
    }
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

  async function releaseMic() {
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
    return overlay.querySelector(`.record-btn[data-slot="${slot}"]`);
  }

  function setClipStatus(slot, message) {
    const btn = findRecordButton(slot);
    const status = btn?.closest('[data-slot-wrap]')?.querySelector('.clip-status')
      || btn?.parentElement?.parentElement?.querySelector('.clip-status');
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
      btn.classList.add('bg-red-500/20');
    } else {
      label.textContent = recordings.has(btn.dataset.slot) ? 'Re-record' : 'Record';
      dot.classList.remove('animate-pulse-soft');
      btn.classList.remove('bg-red-500/20');
    }
  }

  function refreshNextButtons() {
    const scriptNext = overlay.querySelector('[data-step="script"] [data-action="next"]');
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
      wrap.className = 'bg-white/[0.03] border border-white/5 rounded-xl p-4 space-y-2';
      wrap.innerHTML = `
        <p class="text-sm text-neutral-300">${prompt}</p>
        <div class="flex items-center gap-3">
          <button data-action="record" data-slot="${slot}" class="record-btn px-3 py-1.5 rounded-full bg-white/10 hover:bg-white/15 text-xs flex items-center gap-2 transition-colors">
            <span class="rec-indicator w-1.5 h-1.5 rounded-full bg-red-500"></span>
            <span class="rec-label">Record</span>
          </button>
          <audio class="preview-audio hidden" controls style="height: 28px;"></audio>
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
    formData.append('personality_note', toneInput.value.trim());

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
    releaseMic();
    goToStep('done');
    setTimeout(() => closeOverlay(), 1800);
  }

  function showError(message) {
    errorTextEl.textContent = message;
    goToStep('error');
  }

  // -----------------------------------------------------------------------
  // Wiring
  // -----------------------------------------------------------------------
  overlay.addEventListener('click', (e) => {
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
      goToStep('tone');
    } else if (action === 'skip') {
      localStorage.setItem(SKIP_STORAGE_KEY, '1');
      closeOverlay();
    }
  });

  if (setupBtn) {
    setupBtn.addEventListener('click', () => {
      localStorage.removeItem(SKIP_STORAGE_KEY);
      openOverlay();
    });
  }

  // -----------------------------------------------------------------------
  // Boot: decide whether onboarding should auto-open
  // -----------------------------------------------------------------------
  async function init() {
    // Hold the editor until we know whether onboarding needs to run, so a
    // fast typist can't sneak a keystroke in before the overlay appears.
    if (editorEl) editorEl.disabled = true;

    try {
      const response = await fetch(PROFILE_ENDPOINT);
      if (!response.ok) throw new Error(`profile fetch failed: ${response.status}`);
      profileData = await response.json();
    } catch (err) {
      console.warn('[InnerVoice] could not load voice profile', err);
      if (editorEl) editorEl.disabled = false;
      return;
    }

    if (!profileData.supported) {
      if (editorEl) editorEl.disabled = false;
      return; // no ElevenLabs configured; stay out of the way.
    }

    scriptTextEl.textContent = profileData.reading_script;
    renderPersonalityPrompts(profileData.personality_prompts || []);
    setupBtn.classList.remove('hidden');
    setupBtn.textContent = profileData.has_voice ? 're-record voice' : 'set up voice';

    const skipped = localStorage.getItem(SKIP_STORAGE_KEY) === '1';
    if (!profileData.has_voice && !skipped) {
      openOverlay();
    } else if (editorEl) {
      editorEl.disabled = false;
    }
  }

  // This script tag sits at the end of <body>, so the DOM is already parsed
  // by the time we get here -- no need to wait for DOMContentLoaded (which,
  // this late, may have already fired).
  init();
})();
