/**
 * onboarding.js
 * -------------
 * Script for the dedicated `/onboarding.html` page (a real page navigation,
 * not a popup/overlay on top of the editor):
 *
 *   1. Fetch /api/voice/profile. If Instant Voice Clone isn't available,
 *      bounce straight back to the editor -- nothing to do here.
 *   2. Read a single short script out loud (MediaRecorder). Just one clean,
 *      consistently-delivered reading -- mixing in separate free-response
 *      recordings tended to introduce tone/accent drift into the clone.
 *   3. POST that recording to /api/voice/clone. The backend runs ElevenLabs
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
  const STEP_ORDER = ['welcome', 'script'];
  const SCRIPT_SLOT = 'script';

  const stepsEl = document.getElementById('onboarding-steps');
  const scriptTextEl = document.getElementById('onboarding-script-text');
  const errorTextEl = document.getElementById('onboarding-error-text');

  let mediaStream = null;
  let activeRecording = null; // { recorder, chunks }
  let scriptBlob = null;

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
    try {
      // Browsers turn on echoCancellation/noiseSuppression/autoGainControl
      // by default -- great for video calls, bad for voice cloning: they're
      // tuned to suppress/compress the signal for robustness, not fidelity,
      // and often introduce artifacts or "pump" the volume during pauses.
      // Ask for the rawest signal the browser will give us.
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    } catch (err) {
      // Some browsers reject unsupported constraint combinations outright;
      // fall back to a plain request rather than failing to record at all.
      console.warn('[InnerVoice] falling back to default audio constraints', err);
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }
    return mediaStream;
  }

  function recordButton() {
    return document.querySelector(`.record-btn[data-slot="${SCRIPT_SLOT}"]`);
  }

  function setClipStatus(message) {
    document.querySelector('.clip-status').textContent = message;
  }

  function updatePreview(blob) {
    const audioEl = document.querySelector('.preview-audio');
    if (audioEl) {
      audioEl.src = URL.createObjectURL(blob);
      audioEl.classList.remove('hidden');
    }
  }

  async function toggleRecording() {
    const btn = recordButton();
    if (activeRecording) {
      activeRecording.recorder.stop();
      return;
    }

    let stream;
    try {
      stream = await ensureMic();
    } catch (err) {
      console.warn('[InnerVoice] mic permission denied', err);
      setClipStatus("Couldn't access your microphone -- check browser permissions.");
      return;
    }

    const mimeType = pickMimeType();
    // Without an explicit bitrate, browsers often pick a conservative
    // default tuned for small file size (voice messages, etc.), which adds
    // more lossy compression on top of an already-lossy codec. 256kbps is
    // comfortably above what Opus/AAC need to sound transparent for speech.
    const recorderOptions = { audioBitsPerSecond: 256000 };
    if (mimeType) recorderOptions.mimeType = mimeType;
    const recorder = new MediaRecorder(stream, recorderOptions);
    const chunks = [];

    recorder.addEventListener('dataavailable', (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    });

    recorder.addEventListener('stop', () => {
      scriptBlob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      activeRecording = null;
      setRecordButtonState(btn, 'idle');
      setClipStatus('Saved — you can re-record if you want.');
      updatePreview(scriptBlob);
      refreshSubmitButton();
    });

    recorder.start();
    activeRecording = { recorder, chunks };
    setRecordButtonState(btn, 'recording');
    setClipStatus('Recording… click again to stop.');
  }

  function setRecordButtonState(btn, state) {
    if (!btn) return;
    const label = btn.querySelector('.rec-label');
    const dot = btn.querySelector('.rec-indicator');
    if (state === 'recording') {
      label.textContent = 'Stop';
      dot.classList.add('animate-pulse-soft');
    } else {
      label.textContent = scriptBlob ? 'Re-record' : 'Record';
      dot.classList.remove('animate-pulse-soft');
    }
  }

  function refreshSubmitButton() {
    const submitBtn = document.querySelector('[data-step="script"] [data-action="submit"]');
    if (submitBtn) submitBtn.disabled = !scriptBlob;
  }

  // -----------------------------------------------------------------------
  // Submission
  // -----------------------------------------------------------------------
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

  // -----------------------------------------------------------------------
  // Wiring
  // -----------------------------------------------------------------------
  document.addEventListener('click', (e) => {
    const target = e.target.closest('[data-action]');
    if (!target) return;
    const action = target.dataset.action;

    if (action === 'record') {
      toggleRecording();
    } else if (action === 'start') {
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
    goToStep('welcome');
  }

  init();
})();
