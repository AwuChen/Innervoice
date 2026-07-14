/**
 * voice-match.js
 * --------------
 * First-run (and on-demand "retest") voice-match test that gates the main
 * editor: shows a short passage, and while the user reads it silently, the
 * cloned ElevenLabs voice reads it aloud in sync -- each word highlighted
 * (karaoke-style) as it's spoken, using word-level timestamps from
 * `POST /api/voice-test/speak`. If it doesn't sound right, the user picks
 * feedback tags that nudge the persisted voice settings
 * (backend/voice_profile.py), then can try again on the same passage.
 *
 * This intentionally owns the show/hide toggle between `#voice-match` and
 * `#editor` -- app.js doesn't need to know this exists; it just finds the
 * editor hidden or visible as this module leaves it.
 */

(() => {
  'use strict';

  const DONE_STORAGE_KEY = 'innervoice.voiceMatchDone';
  const PASSAGE_ENDPOINT = '/api/voice-test/passage';
  const SPEAK_ENDPOINT = '/api/voice-test/speak';
  const FEEDBACK_ENDPOINT = '/api/voice-test/feedback';
  const CONFIG_ENDPOINT = '/api/config';

  const FEEDBACK_TAGS = [
    { id: 'too_fast', label: 'Too fast' },
    { id: 'too_slow', label: 'Too slow' },
    { id: 'pitch_too_high', label: 'Pitch too high' },
    { id: 'pitch_too_low', label: 'Pitch too low' },
    { id: 'too_robotic', label: 'Too robotic / flat' },
    { id: 'too_erratic', label: 'Too erratic / unstable' },
    { id: 'not_like_me', label: "Doesn't sound like me" },
    { id: 'too_exaggerated', label: 'Too exaggerated' },
  ];

  const voiceMatchSection = document.getElementById('voice-match');
  const editor = document.getElementById('editor');
  const retestLink = document.getElementById('retest-voice-link');
  const statusEl = document.getElementById('voice-match-status');
  const passageEl = document.getElementById('voice-match-passage');
  const beginBtn = document.getElementById('voice-match-begin');
  const resultEl = document.getElementById('voice-match-result');
  const yesBtn = document.getElementById('voice-match-yes');
  const noBtn = document.getElementById('voice-match-no');
  const feedbackEl = document.getElementById('voice-match-feedback');
  const chipsEl = document.getElementById('voice-match-chips');
  const submitBtn = document.getElementById('voice-match-submit');
  const skipBtn = document.getElementById('voice-match-skip');

  let preloadMs = 600; // overwritten from /api/config once loaded
  let currentPassageId = null;
  let currentWords = []; // [{text, start, end}]
  let currentAudioBase64 = null;
  let currentPitchRate = 1.0;
  let audioEl = null;
  let rafId = null;
  const selectedIssues = new Set();

  async function fetchPreloadMs() {
    try {
      const response = await fetch(CONFIG_ENDPOINT);
      if (response.ok) {
        const config = await response.json();
        if (typeof config.voice_test_preroll_ms === 'number') {
          preloadMs = config.voice_test_preroll_ms;
        }
      }
    } catch {
      /* keep default */
    }
  }

  function renderPassageWords(text) {
    passageEl.innerHTML = '';
    text.split(/\s+/).forEach((word, i) => {
      if (i > 0) passageEl.appendChild(document.createTextNode(' '));
      const span = document.createElement('span');
      span.className = 'word';
      span.textContent = word;
      passageEl.appendChild(span);
    });
  }

  function clearHighlight() {
    passageEl.querySelectorAll('.word.active').forEach((el) => el.classList.remove('active'));
  }

  async function fetchSpeak(passageId) {
    const response = await fetch(SPEAK_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passage_id: passageId }),
    });
    if (!response.ok) {
      throw new Error(`voice-test speak failed: ${response.status}`);
    }
    return response.json();
  }

  async function loadNewPassage() {
    beginBtn.classList.remove('hidden');
    beginBtn.disabled = true;
    beginBtn.textContent = 'Loading your voice…';
    statusEl.textContent =
      "Before you start writing, let's check your InnerVoice. Read the passage below in your head — I'll read it back to you.";
    resultEl.classList.add('hidden');
    feedbackEl.classList.add('hidden');
    selectedIssues.clear();

    try {
      const passageResponse = await fetch(PASSAGE_ENDPOINT);
      const passage = await passageResponse.json();
      currentPassageId = passage.id;
      renderPassageWords(passage.text);

      const speak = await fetchSpeak(passage.id);
      currentWords = speak.words || [];
      currentAudioBase64 = speak.audio_base64;
      currentPitchRate = speak.pitch_playback_rate || 1.0;

      beginBtn.disabled = false;
      beginBtn.textContent = 'Begin';
    } catch (err) {
      console.warn('[InnerVoice] voice-match: failed to load passage/voice', err);
      statusEl.textContent = "Couldn't load your voice just now.";
      beginBtn.textContent = 'Retry';
      beginBtn.disabled = false;
      beginBtn.onclick = loadNewPassage;
    }
  }

  async function refetchSpeakForCurrentPassage() {
    beginBtn.classList.remove('hidden');
    beginBtn.disabled = true;
    beginBtn.textContent = 'Loading your voice…';
    try {
      const speak = await fetchSpeak(currentPassageId);
      currentWords = speak.words || [];
      currentAudioBase64 = speak.audio_base64;
      currentPitchRate = speak.pitch_playback_rate || 1.0;
      beginBtn.disabled = false;
      beginBtn.textContent = 'Try again';
    } catch (err) {
      console.warn('[InnerVoice] voice-match: failed to re-synthesize', err);
      beginBtn.disabled = false;
      beginBtn.textContent = 'Try again';
    }
  }

  function base64ToBlobUrl(base64, mime) {
    const byteChars = atob(base64);
    const byteNumbers = new Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
    const blob = new Blob([new Uint8Array(byteNumbers)], { type: mime });
    return URL.createObjectURL(blob);
  }

  function applyPitchRate(el, rate) {
    // Independent pitch shifting would need a phase vocoder; this couples a
    // small pitch nudge with a small tempo change instead, which is a
    // disclosed trade-off (see docs/research-roadmap.md).
    el.preservesPitch = false;
    el.mozPreservesPitch = false;
    el.webkitPreservesPitch = false;
    el.playbackRate = rate;
  }

  function wordSpans() {
    return passageEl.querySelectorAll('.word');
  }

  function startHighlightLoop() {
    const spans = wordSpans();
    const tick = () => {
      if (!audioEl) return;
      const t = audioEl.currentTime;
      let activeIndex = -1;
      for (let i = 0; i < currentWords.length; i++) {
        if (t >= currentWords[i].start && t < currentWords[i].end) {
          activeIndex = i;
          break;
        }
      }
      spans.forEach((span, i) => span.classList.toggle('active', i === activeIndex));
      if (audioEl && !audioEl.ended && !audioEl.paused) {
        rafId = requestAnimationFrame(tick);
      }
    };
    rafId = requestAnimationFrame(tick);
  }

  function stopPlayback() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    if (audioEl) {
      try {
        audioEl.pause();
      } catch {
        /* no-op */
      }
    }
    clearHighlight();
  }

  function playCurrentClip() {
    stopPlayback();
    const url = base64ToBlobUrl(currentAudioBase64, 'audio/mpeg');
    audioEl = new Audio(url);
    applyPitchRate(audioEl, currentPitchRate);
    audioEl.addEventListener('ended', () => {
      clearHighlight();
      beginBtn.classList.add('hidden');
      resultEl.classList.remove('hidden');
    });
    audioEl.play().catch((err) => console.warn('[InnerVoice] voice-match playback failed', err));
    startHighlightLoop();
  }

  function onBeginClick() {
    beginBtn.disabled = true;
    beginBtn.textContent = 'Get ready…';
    setTimeout(() => {
      beginBtn.textContent = 'Playing…';
      playCurrentClip();
    }, preloadMs);
  }

  function renderChips() {
    chipsEl.innerHTML = '';
    FEEDBACK_TAGS.forEach((tag) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className =
        'voice-match-chip px-3 py-1 rounded-full border border-neutral-700 text-neutral-400 text-xs transition-colors';
      chip.textContent = tag.label;
      chip.dataset.issue = tag.id;
      chip.addEventListener('click', () => {
        if (selectedIssues.has(tag.id)) {
          selectedIssues.delete(tag.id);
          chip.classList.remove('selected');
        } else {
          selectedIssues.add(tag.id);
          chip.classList.add('selected');
        }
      });
      chipsEl.appendChild(chip);
    });
  }

  async function postFeedback(matched, issues) {
    try {
      const response = await fetch(FEEDBACK_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passage_id: currentPassageId, matched, issues }),
      });
      if (response.ok) return response.json();
    } catch (err) {
      console.warn('[InnerVoice] voice-match: failed to submit feedback', err);
    }
    return null;
  }

  function markDoneAndRevealEditor() {
    try {
      window.localStorage.setItem(DONE_STORAGE_KEY, '1');
    } catch {
      /* localStorage unavailable; the gate will just show again next load */
    }
    stopPlayback();
    voiceMatchSection.classList.add('hidden');
    editor.classList.remove('hidden');
    retestLink.classList.remove('hidden');
    editor.focus();
  }

  async function onYesClick() {
    await postFeedback(true, []);
    markDoneAndRevealEditor();
  }

  function onNoClick() {
    resultEl.classList.add('hidden');
    renderChips();
    feedbackEl.classList.remove('hidden');
  }

  async function onSubmitFeedbackClick() {
    const issues = Array.from(selectedIssues);
    submitBtn.disabled = true;
    submitBtn.textContent = 'Adjusting…';
    await postFeedback(false, issues);
    feedbackEl.classList.add('hidden');
    submitBtn.disabled = false;
    submitBtn.textContent = 'Submit & try again';
    await refetchSpeakForCurrentPassage();
  }

  function onSkipClick() {
    markDoneAndRevealEditor();
  }

  async function openGate() {
    editor.classList.add('hidden');
    retestLink.classList.add('hidden');
    voiceMatchSection.classList.remove('hidden');
    resultEl.classList.add('hidden');
    feedbackEl.classList.add('hidden');
    await loadNewPassage();
  }

  beginBtn.addEventListener('click', onBeginClick);
  yesBtn.addEventListener('click', onYesClick);
  noBtn.addEventListener('click', onNoClick);
  submitBtn.addEventListener('click', onSubmitFeedbackClick);
  skipBtn.addEventListener('click', onSkipClick);
  retestLink.addEventListener('click', openGate);

  (async () => {
    await fetchPreloadMs();

    let alreadyDone = false;
    try {
      alreadyDone = window.localStorage.getItem(DONE_STORAGE_KEY) === '1';
    } catch {
      alreadyDone = false;
    }

    if (alreadyDone) {
      voiceMatchSection.classList.add('hidden');
      editor.classList.remove('hidden');
      retestLink.classList.remove('hidden');
      editor.focus();
    } else {
      await openGate();
    }
  })();
})();
