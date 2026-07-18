/**
 * app.js
 * ------
 * InnerVoice frontend: keystroke listener + debounce, prediction requests,
 * and a low-latency streaming audio playback engine.
 *
 * Design goals:
 *   1. Never block the text editor. All network/audio work is async and
 *      the <textarea> stays perfectly responsive no matter what the
 *      audio pipeline is doing.
 *   2. Start playing audio as soon as the *first* bytes arrive (via the
 *      Media Source Extensions API), not after the whole clip downloads.
 *   3. The instant the user resumes typing, any in-flight request and any
 *      currently-playing whisper are torn down (with a quick fade-out so
 *      it doesn't feel like a hard cut).
 */

(() => {
  'use strict';

  // ---------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------
  const DEBOUNCE_MS = 400; // pause length that triggers a prediction
  const MIN_CONTEXT_CHARS = 6; // mirrors backend MIN_CONTEXT_CHARS
  const FADE_OUT_SECONDS = 0.15; // quick, unobtrusive fade when interrupted
  const PREDICT_ENDPOINT = '/api/predict';
  const PERSONAS_ENDPOINT = '/api/personas';
  const CONFIG_ENDPOINT = '/api/config';
  const EVENT_ENDPOINT = '/api/event';
  const CAPTION_VISIBLE_MS = 4500;
  const PERSONA_TAGLINE_VISIBLE_MS = 2500;
  const PERSONA_STORAGE_KEY = 'innervoice.personaIndex';
  const CAROUSEL_ROWS_VISIBLE = 3; // odd, so the active persona sits dead-center

  // Used only if /api/personas can't be reached; kept in sync with
  // backend/personas.py so the slider still works offline/degraded.
  const FALLBACK_PERSONAS = [
    { id: 'voice', label: 'Voice', tagline: 'Your intuitive undercurrent.' },
    { id: 'mentor', label: 'Mentor', tagline: 'Nudges you toward clarity and growth.' },
    { id: 'friend', label: 'Friend', tagline: 'Warm, validating, always on your side.' },
    { id: 'demon', label: 'Demon', tagline: 'Cynical, doubtful, quick to second-guess.' },
    { id: 'future_self', label: 'FutureSelf', tagline: 'You, further down the timeline.' },
    { id: 'absent', label: 'Absent', tagline: 'Absent-minded: loops the thought already on the page.' },
    { id: 'ensemble', label: 'Ensemble', tagline: 'Auto-picks which inner voice should chime in next.', auto_select: true },
    { id: 'rap', label: 'Rap', tagline: 'Turns your thoughts into bars.' },
  ];

  const RAP_SONG_ENDPOINT = '/api/rap-song';

  // ---------------------------------------------------------------------
  // Research-knob config (docs/research-roadmap.md #3/#4), fetched once
  // from the backend so this prototype can be A/B'd without a rebuild --
  // see backend/config.py SHOW_CAPTION / ENABLE_WHISPER_MEMORY.
  // ---------------------------------------------------------------------
  let appConfig = {
    showCaption: true,
    enableWhisperMemory: false,
    whisperMemoryTurns: 3,
    // "Echo Mode" (roadmap #10): reveal the whisper's text word-by-word,
    // paced to an assumed speaking rate, then leave it on screen instead
    // of fading -- see startEchoReveal() below.
    enableEchoReveal: false,
    echoRevealWpm: 165,
    pitchPlaybackRate: 1.0,
  };

  async function loadConfig() {
    try {
      const response = await fetch(CONFIG_ENDPOINT);
      if (response.ok) {
        const fetched = await response.json();
        appConfig = {
          showCaption: fetched.show_caption !== undefined ? !!fetched.show_caption : true,
          enableWhisperMemory: !!fetched.enable_whisper_memory,
          whisperMemoryTurns: fetched.whisper_memory_turns || 3,
          enableEchoReveal: !!fetched.enable_echo_reveal,
          echoRevealWpm: fetched.echo_reveal_wpm || 165,
          // Set by the voice-match test's feedback loop (backend/voice_profile.py)
          // so the live whisper reflects the same pitch tuning, not just the test.
          pitchPlaybackRate: fetched.pitch_playback_rate || 1.0,
        };
      }
    } catch (err) {
      console.warn('[InnerVoice] failed to load config, using defaults', err);
    }
    player.setPitchRate(appConfig.pitchPlaybackRate);
  }

  /** Best-effort fire-and-forget beacon for research instrumentation --
   * never awaited, never allowed to affect the actual product loop. */
  function reportEvent(eventType, payload) {
    try {
      fetch(EVENT_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_type: eventType, payload: payload || {} }),
        keepalive: true,
      }).catch(() => {});
    } catch {
      /* no-op */
    }
  }

  // Rolling memory of recently whispered continuations (roadmap #4's
  // "does the context window need to grow" question). Only populated/sent
  // when the backend has ENABLE_WHISPER_MEMORY on.
  const whisperHistory = [];
  const WHISPER_HISTORY_MAX = 10;

  // ---------------------------------------------------------------------
  // DOM refs
  // ---------------------------------------------------------------------
  const editor = document.getElementById('editor');
  const statusChip = document.getElementById('status-chip');
  const statusDot = document.getElementById('status-dot');
  const statusLabel = document.getElementById('status-label');
  const captionEl = document.getElementById('whisper-caption');
  const wordmarkEl = document.getElementById('wordmark');
  const personaCarouselEl = document.getElementById('persona-carousel');
  const personaCarouselTrackEl = document.getElementById('persona-carousel-track');
  const personaTaglineEl = document.getElementById('persona-tagline');

  // ---------------------------------------------------------------------
  // Status indicator (tiny, top-right — never intrusive).
  // While whispering, the chip is clickable so the user can cut off speech
  // early (especially long InnerRap karaoke performances).
  // ---------------------------------------------------------------------
  const STATUS_STYLES = {
    listening: { dot: 'bg-neutral-600', animate: false, label: 'listening' },
    thinking: { dot: 'bg-amber-400', animate: true, label: 'thinking' },
    whispering: { dot: 'bg-emerald-400', animate: true, label: 'whispering' },
  };
  let currentStatus = 'listening';

  function setStatus(state) {
    currentStatus = STATUS_STYLES[state] ? state : 'listening';
    const style = STATUS_STYLES[currentStatus];
    statusDot.className = `w-1.5 h-1.5 rounded-full transition-colors ${style.dot} ${
      style.animate ? 'animate-pulse-soft' : ''
    }`;
    statusLabel.textContent = style.label;
    if (statusChip) {
      const stoppable = currentStatus === 'whispering';
      statusChip.title = stoppable ? 'Click to stop' : '';
      statusChip.setAttribute('aria-label', stoppable ? 'Stop InnerVoice' : style.label);
      statusChip.classList.toggle('cursor-pointer', stoppable);
      statusChip.classList.toggle('hover:text-neutral-300', stoppable);
      statusChip.classList.toggle('cursor-default', !stoppable);
    }
  }

  let captionTimer = null;

  function setCaptionText(text) {
    captionEl.textContent = text ? `“${text}”` : '';
  }

  function playFadeInAnimation() {
    captionEl.classList.remove('animate-fade-in');
    // eslint-disable-next-line no-unused-expressions
    captionEl.offsetHeight; // restart the fade-in animation
    captionEl.classList.add('animate-fade-in');
    captionEl.style.opacity = '1';
  }

  /** Default (Echo Mode off) behavior: show the whole phrase instantly in
   * the caption, then fade it out on a fixed timer -- unchanged. */
  function showCaptionInstant(text) {
    if (!text || !appConfig.showCaption) return;
    clearTimeout(captionTimer);
    setCaptionText(text);
    playFadeInAnimation();
    captionTimer = setTimeout(() => {
      captionEl.style.opacity = '0';
    }, CAPTION_VISIBLE_MS);
  }

  function hideCaptionSoon() {
    clearTimeout(captionTimer);
    captionTimer = setTimeout(() => {
      captionEl.style.opacity = '0';
    }, 300);
  }

  // ---------------------------------------------------------------------
  // "Echo Mode" (docs/research-roadmap.md #10): instead of showing the
  // whisper in a separate caption, it is typed directly into the editor
  // -- word-by-word, paced to an assumed speaking rate
  // (`appConfig.echoRevealWpm`) rather than an exact per-word timestamp
  // sync (see the roadmap doc for that trade-off). Once fully typed it's
  // just part of the document, rereadable like anything the user typed
  // themselves -- that's the point of the reinforcement loop.
  // ---------------------------------------------------------------------
  let echoRevealRafId = null;
  let echoRevealToken = 0; // bumped to invalidate any in-flight reveal loop
  let echoInsertion = null; // { start, end, prefix } -- not-yet-committed range in editor.value

  function cancelEchoReveal() {
    if (echoRevealRafId) {
      cancelAnimationFrame(echoRevealRafId);
      echoRevealRafId = null;
    }
    echoRevealToken += 1;
  }

  function growEchoInsertionTo(revealedText) {
    if (!echoInsertion) return;
    const { start, end } = echoInsertion;
    const value = editor.value;
    editor.value = value.slice(0, start) + revealedText + value.slice(end);
    echoInsertion.end = start + revealedText.length;
    editor.selectionStart = editor.selectionEnd = echoInsertion.end;
  }

  /** The reveal finished typing (or was force-completed): from now on this
   * text is indistinguishable from anything the user typed themselves, so
   * stop tracking it for rollback. */
  function commitEchoInsertion() {
    echoInsertion = null;
  }

  /** Typing resumed while a reveal was still mid-type: remove the
   * not-yet-committed AI text, preserving whatever the user just typed at
   * that spot -- "typing always wins" applies to in-editor reveals exactly
   * like it already does to audio playback. */
  function rollbackEchoInsertion() {
    if (!echoInsertion) return;
    const { start, end } = echoInsertion;
    const caretNow = editor.selectionStart;
    const value = editor.value;
    const safeEnd = Math.min(end, value.length);
    const typedSinceEnd = Math.max(0, caretNow - safeEnd);
    editor.value = value.slice(0, start) + value.slice(safeEnd);
    editor.selectionStart = editor.selectionEnd = Math.min(editor.value.length, start + typedSinceEnd);
    echoInsertion = null;
  }

  /**
   * Starts typing `text` into the editor at the current cursor position,
   * word-by-word. Cancelable via `isStale()` plus a local generation
   * token, the same "newer request wins" pattern WhisperPlayer uses.
   *
   * @returns {number} this reveal's generation token, for completeEchoReveal().
   */
  function startEchoReveal(text, isStale) {
    if (!text) return null;
    cancelEchoReveal();
    const revealGen = echoRevealToken;

    const words = text.split(/\s+/).filter(Boolean);
    const wordCount = words.length || 1;
    const revealDurationMs = Math.max(600, (wordCount / appConfig.echoRevealWpm) * 60000);

    const insertStart = editor.selectionStart;
    const needsLeadingSpace = insertStart > 0 && !/\s$/.test(editor.value.slice(0, insertStart));
    echoInsertion = { start: insertStart, end: insertStart, prefix: needsLeadingSpace ? ' ' : '' };

    const startTime = performance.now();
    const tick = () => {
      if (isStale() || echoRevealToken !== revealGen) return; // superseded, bail silently
      const fraction = Math.min(1, (performance.now() - startTime) / revealDurationMs);
      const revealedCount = Math.max(1, Math.round(fraction * wordCount));
      growEchoInsertionTo(echoInsertion.prefix + words.slice(0, revealedCount).join(' '));
      if (fraction < 1) {
        echoRevealRafId = requestAnimationFrame(tick);
      } else {
        echoRevealRafId = null;
        commitEchoInsertion(); // fully typed -- just part of the document now
      }
    };
    echoRevealRafId = requestAnimationFrame(tick);
    return revealGen;
  }

  /** Called when the whisper's audio finishes naturally: if the WPM-based
   * pacing estimate ran slower than the actual audio, snap straight to the
   * full text and commit it immediately. No-op if the reveal already
   * finished typing on its own, or was superseded/rolled back. */
  function completeEchoReveal(revealGen, fullText) {
    if (revealGen === null || echoRevealToken !== revealGen || !echoInsertion) return;
    if (echoRevealRafId) cancelAnimationFrame(echoRevealRafId);
    echoRevealRafId = null;
    const words = fullText.split(/\s+/).filter(Boolean);
    growEchoInsertionTo(echoInsertion.prefix + words.join(' '));
    commitEchoInsertion();
  }

  // ---------------------------------------------------------------------
  // Persona steering: there is no visible slider or button at all -- you
  // drag directly on the wordmark. The suffix ("Voice"/"Mentor"/...) is a
  // vertical reel of every persona name; dragging up/down spins it like a
  // carousel/slot wheel and it snaps to the nearest persona on release.
  // Changing personas swaps which "inner voice" system prompt the backend
  // uses (see backend/personas.py) -- it's purely a text-steering control,
  // never touching the TTS voice itself.
  // ---------------------------------------------------------------------
  let personas = FALLBACK_PERSONAS;
  let personaIndex = 0;
  let itemHeightPx = 0;
  let personaTaglineTimer = null;

  let isDragging = false;
  let dragStartY = 0;
  let dragStartOffset = 0;
  let liveOffset = 0;

  function showPersonaTagline(text) {
    if (!text) return;
    clearTimeout(personaTaglineTimer);
    personaTaglineEl.textContent = text;
    personaTaglineEl.style.opacity = '1';
    personaTaglineTimer = setTimeout(() => {
      personaTaglineEl.style.opacity = '0';
    }, PERSONA_TAGLINE_VISIBLE_MS);
  }

  // The track is [spacer, item0, item1, ..., itemN-1, spacer]. At
  // translateY = -index * itemHeightPx, row `index` (offset by the leading
  // spacer) lands exactly in the middle of the 3-row visible window.
  function offsetForIndex(index) {
    return -index * itemHeightPx;
  }

  function clampOffset(offset) {
    const min = offsetForIndex(personas.length - 1);
    const max = offsetForIndex(0);
    return Math.min(max, Math.max(min, offset));
  }

  const rapSongBtn = document.getElementById('rap-song-btn');

  function updateRapSongButton() {
    if (!rapSongBtn) return;
    const isRap = currentPersonaId() === 'rap';
    rapSongBtn.classList.toggle('hidden', !isRap);
  }

  function applyPersona(index, { silent = false } = {}) {
    const clamped = Math.max(0, Math.min(personas.length - 1, index));
    personaIndex = clamped;
    const persona = personas[personaIndex];
    if (!persona) return;

    liveOffset = offsetForIndex(personaIndex);
    personaCarouselTrackEl.style.transform = `translateY(${liveOffset}px)`;
    if (!silent) showPersonaTagline(persona.tagline);
    updateRapSongButton();

    try {
      window.localStorage.setItem(PERSONA_STORAGE_KEY, String(personaIndex));
    } catch {
      /* localStorage unavailable (e.g. private mode); persona just won't persist. */
    }
  }

  function buildCarousel() {
    personaCarouselTrackEl.innerHTML = '';

    const firstLabel = personas.length > 0 ? personas[0].label : '';
    const lastLabel = personas.length > 0 ? personas[personas.length - 1].label : '';

    const spacerTop = document.createElement('span');
    spacerTop.className = 'persona-carousel-item persona-carousel-spacer';
    spacerTop.textContent = firstLabel || '\u00A0';
    personaCarouselTrackEl.appendChild(spacerTop);

    personas.forEach((persona) => {
      const item = document.createElement('span');
      item.className = 'persona-carousel-item';
      item.textContent = persona.label;
      personaCarouselTrackEl.appendChild(item);
    });

    const spacerBottom = document.createElement('span');
    spacerBottom.className = 'persona-carousel-item persona-carousel-spacer';
    spacerBottom.textContent = lastLabel || '\u00A0';
    personaCarouselTrackEl.appendChild(spacerBottom);

    let maxWidth = 0;
    Array.from(personaCarouselTrackEl.children).forEach((child) => {
      maxWidth = Math.max(maxWidth, child.getBoundingClientRect().width);
    });
    const sample = personaCarouselTrackEl.children[1] || personaCarouselTrackEl.children[0];
    itemHeightPx = (sample && sample.getBoundingClientRect().height) || 20;

    personaCarouselEl.style.width = `${Math.ceil(maxWidth)}px`;
    personaCarouselEl.style.height = `${itemHeightPx * CAROUSEL_ROWS_VISIBLE}px`;
  }

  function onWordmarkPointerDown(event) {
    isDragging = true;
    dragStartY = event.clientY;
    dragStartOffset = offsetForIndex(personaIndex);
    liveOffset = dragStartOffset;
    wordmarkEl.classList.add('dragging');
    personaCarouselTrackEl.classList.add('no-transition');
    try {
      wordmarkEl.setPointerCapture(event.pointerId);
    } catch {
      /* no-op */
    }
  }

  function onWordmarkPointerMove(event) {
    if (!isDragging) return;
    const deltaY = event.clientY - dragStartY;
    liveOffset = clampOffset(dragStartOffset + deltaY);
    personaCarouselTrackEl.style.transform = `translateY(${liveOffset}px)`;
  }

  function endWordmarkDrag() {
    if (!isDragging) return;
    isDragging = false;
    wordmarkEl.classList.remove('dragging');
    personaCarouselTrackEl.classList.remove('no-transition');

    const draggedIndex = Math.round(-liveOffset / itemHeightPx);
    applyPersona(draggedIndex);
  }

  function attachDragHandlers() {
    wordmarkEl.addEventListener('pointerdown', onWordmarkPointerDown);
    wordmarkEl.addEventListener('pointermove', onWordmarkPointerMove);
    wordmarkEl.addEventListener('pointerup', endWordmarkDrag);
    wordmarkEl.addEventListener('pointercancel', endWordmarkDrag);
  }

  function initPersonaCarousel() {
    buildCarousel();

    let storedIndex = 0;
    try {
      storedIndex = parseInt(window.localStorage.getItem(PERSONA_STORAGE_KEY), 10);
    } catch {
      storedIndex = 0;
    }
    if (Number.isNaN(storedIndex)) storedIndex = 0;
    storedIndex = Math.max(0, Math.min(personas.length - 1, storedIndex));

    // Sync the reel to the stored persona without transition/tagline flash
    // on initial page load, then re-enable the snap animation.
    personaCarouselTrackEl.classList.add('no-transition');
    applyPersona(storedIndex, { silent: true });
    requestAnimationFrame(() => personaCarouselTrackEl.classList.remove('no-transition'));

    attachDragHandlers();
  }

  async function loadPersonas() {
    try {
      const response = await fetch(PERSONAS_ENDPOINT);
      if (response.ok) {
        const fetched = await response.json();
        if (Array.isArray(fetched) && fetched.length > 0) {
          personas = fetched;
        }
      }
    } catch (err) {
      console.warn('[InnerVoice] failed to load personas, using fallback list', err);
    }
    initPersonaCarousel();
  }

  function currentPersonaId() {
    return (personas[personaIndex] && personas[personaIndex].id) || 'voice';
  }

  // ---------------------------------------------------------------------
  // WhisperPlayer: owns the Web Audio graph + streaming playback mechanics.
  // Knows nothing about *when* to play/stop — that's the caller's job via
  // the `isStale()` check, which lets an in-flight stream self-cancel the
  // instant it's superseded by a newer request.
  // ---------------------------------------------------------------------
  class WhisperPlayer {
    constructor() {
      this.audioCtx = null;
      this.audioEl = null;
      this.gainNode = null;
      this.sourceNode = null;
      this.mediaSource = null;
      this.fadeTimer = null;
      this.pitchRate = 1.0;
    }

    /** Call this as early as possible (e.g. first keydown) to capture the
     * browser's "user activation" window needed to unlock audio playback. */
    primeAudioContext() {
      this._ensureContext();
    }

    /** Set once from the voice-match test's persisted tuning (see
     * backend/voice_profile.py) so the live whisper reflects the same pitch
     * nudge, not just the standalone test. A small, disclosed speed/pitch
     * coupling via playbackRate -- see docs/research-roadmap.md. */
    setPitchRate(rate) {
      this.pitchRate = rate || 1.0;
      if (this.audioEl) this._applyPitchRate();
    }

    _applyPitchRate() {
      this.audioEl.preservesPitch = false;
      this.audioEl.mozPreservesPitch = false;
      this.audioEl.webkitPreservesPitch = false;
      this.audioEl.playbackRate = this.pitchRate;
    }

    _ensureContext() {
      if (!this.audioCtx) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        this.audioCtx = new Ctx();
        this.audioEl = new Audio();
        this.audioEl.preload = 'auto';
        this._applyPitchRate();
        this.gainNode = this.audioCtx.createGain();
        this.sourceNode = this.audioCtx.createMediaElementSource(this.audioEl);
        this.sourceNode.connect(this.gainNode).connect(this.audioCtx.destination);
      }
      if (this.audioCtx.state === 'suspended') {
        this.audioCtx.resume().catch(() => {});
      }
    }

    /**
     * Stop whatever is currently playing.
     * @param {boolean} fade - true for a quick fade (typing resumed),
     *                         false for an instant cut (starting a new clip).
     */
    stop({ fade = true } = {}) {
      if (!this.audioEl) return;
      clearTimeout(this.fadeTimer);

      const isActuallyPlaying = !this.audioEl.paused && !this.audioEl.ended;
      if (fade && this.gainNode && isActuallyPlaying) {
        const now = this.audioCtx.currentTime;
        this.gainNode.gain.cancelScheduledValues(now);
        this.gainNode.gain.setValueAtTime(this.gainNode.gain.value, now);
        this.gainNode.gain.linearRampToValueAtTime(0.0001, now + FADE_OUT_SECONDS);
        this.fadeTimer = setTimeout(() => this._hardStop(), FADE_OUT_SECONDS * 1000 + 30);
      } else {
        this._hardStop();
      }
    }

    _hardStop() {
      if (!this.audioEl) return;
      try {
        this.audioEl.pause();
      } catch {
        /* no-op */
      }
      try {
        this.audioEl.removeAttribute('src');
        this.audioEl.load();
      } catch {
        /* no-op */
      }
      if (this.mediaSource && this.mediaSource.readyState === 'open') {
        try {
          this.mediaSource.endOfStream();
        } catch {
          /* no-op */
        }
      }
      this.mediaSource = null;
    }

    /**
     * Play a streaming fetch() Response as audio, appending chunks to the
     * <audio> element via MSE as they arrive (falls back to blob playback
     * on browsers without MSE mp3 support, e.g. Safari).
     *
     * @param {Response} response - the fetch response with a readable body
     * @param {() => boolean} isStale - returns true once this request has
     *        been superseded; the playback loop checks this constantly and
     *        bails out silently the moment it's true.
     * @param {() => void} onEnded - called when playback finishes naturally
     */
    async playStream(response, isStale, onEnded) {
      this._ensureContext();
      this.stop({ fade: false }); // instant clean slate for the new clip

      const now = this.audioCtx.currentTime;
      this.gainNode.gain.cancelScheduledValues(now);
      this.gainNode.gain.setValueAtTime(1, now);
      this.audioEl.onended = () => {
        if (!isStale()) onEnded && onEnded();
      };

      const mime = 'audio/mpeg';
      if (window.MediaSource && MediaSource.isTypeSupported(mime)) {
        await this._playViaMSE(response, isStale, mime);
      } else {
        await this._playViaBlob(response, isStale);
      }
    }

    async _playViaMSE(response, isStale, mime) {
      const mediaSource = new MediaSource();
      this.mediaSource = mediaSource;
      this.audioEl.src = URL.createObjectURL(mediaSource);

      await new Promise((resolve) => {
        mediaSource.addEventListener('sourceopen', resolve, { once: true });
      });
      if (isStale() || mediaSource.readyState !== 'open') return;

      const sourceBuffer = mediaSource.addSourceBuffer(mime);
      const queue = [];
      let streamEnded = false;
      let playbackStarted = false;

      const appendNext = () => {
        if (isStale()) return;
        if (sourceBuffer.updating) return;
        if (queue.length === 0) {
          if (streamEnded && mediaSource.readyState === 'open') {
            try {
              mediaSource.endOfStream();
            } catch {
              /* no-op */
            }
          }
          return;
        }
        try {
          sourceBuffer.appendBuffer(queue.shift());
        } catch (err) {
          console.warn('[InnerVoice] appendBuffer failed', err);
        }
      };

      sourceBuffer.addEventListener('updateend', appendNext);

      const reader = response.body.getReader();
      try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          if (isStale()) break;
          const { done, value } = await reader.read();
          if (isStale()) break;
          if (done) {
            streamEnded = true;
            appendNext();
            break;
          }
          queue.push(value);
          appendNext();
          if (!playbackStarted) {
            playbackStarted = true;
            this.audioEl.play().catch((err) => {
              console.warn('[InnerVoice] playback start failed', err);
            });
          }
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
          /* no-op */
        }
      }
    }

    async _playViaBlob(response, isStale) {
      const blob = await response.blob();
      if (isStale()) return;
      this.audioEl.src = URL.createObjectURL(blob);
      this.audioEl.play().catch((err) => {
        console.warn('[InnerVoice] playback start failed', err);
      });
    }
  }

  const player = new WhisperPlayer();

  // ---------------------------------------------------------------------
  // Request lifecycle: a monotonically increasing token identifies the
  // "current" typing pause. Any older in-flight fetch/stream compares its
  // captured token against the live counter to know it's been superseded.
  // ---------------------------------------------------------------------
  let currentToken = 0;
  let activeAbortController = null;
  let debounceTimer = null;

  // Tracks the whisper currently playing (if any), so we can tell whether
  // it was interrupted mid-playback vs. allowed to finish naturally --
  // the accuracy-proxy signal for the adaptive-duration research question
  // (docs/research-roadmap.md #3).
  let activeWhisper = null; // { token, personaId, predictedText }

  function invalidatePreviousRequest() {
    if (activeWhisper) {
      reportEvent('whisper_interrupted', {
        persona: activeWhisper.personaId,
        predicted_text: activeWhisper.predictedText,
      });
      activeWhisper = null;
    }
    currentToken += 1;
    if (activeAbortController) {
      activeAbortController.abort();
      activeAbortController = null;
    }
    return currentToken;
  }

  /**
   * Extract just the paragraph the cursor is currently sitting in, so we
   * send a focused "current thought" rather than the whole document.
   * Paragraphs are separated by a blank line (one or more empty lines).
   */
  function getCurrentParagraph(textarea) {
    const value = textarea.value;
    const cursor = textarea.selectionStart;
    const boundary = /\n[ \t]*\n/g;

    let start = 0;
    let match;
    while ((match = boundary.exec(value)) !== null) {
      const end = match.index;
      if (cursor <= end) {
        return value.slice(start, end).trim();
      }
      start = boundary.lastIndex;
    }
    return value.slice(start).trim();
  }

  async function requestPrediction(contextText) {
    const token = invalidatePreviousRequest();
    const isStale = () => token !== currentToken;

    activeAbortController = new AbortController();
    setStatus('thinking');

    const personaId = currentPersonaId();
    // Guided opener (docs/research-roadmap.md #11): voice-match.js seeds this
    // flag on the editor right after calibration. Consume it once, for this
    // request only -- every later request in the session is an ordinary turn.
    const isOpening = editor.dataset.awaitingOpeningReply === '1';
    delete editor.dataset.awaitingOpeningReply;
    let response;
    try {
      response = await fetch(PREDICT_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: contextText,
          persona: personaId,
          history: appConfig.enableWhisperMemory ? whisperHistory : [],
          is_opening: isOpening,
        }),
        signal: activeAbortController.signal,
      });
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.warn('[InnerVoice] prediction request failed', err);
      }
      if (!isStale()) setStatus('listening');
      return;
    }

    if (isStale()) return;

    if (response.status === 204 || !response.body) {
      setStatus('listening');
      return;
    }
    if (!response.ok) {
      console.warn('[InnerVoice] prediction request returned', response.status);
      setStatus('listening');
      return;
    }

    const encodedPrediction = response.headers.get('X-Predicted-Text') || '';
    let predictedText = '';
    try {
      predictedText = decodeURIComponent(encodedPrediction);
    } catch {
      predictedText = encodedPrediction;
    }

    // InnerEnsemble: backend auto-picked which concrete persona chimed in.
    // Snap the carousel to that persona so the change is visible (no
    // "Ensemble → Mentor" subtext) -- user can drag back to Ensemble anytime.
    const activePersonaId = response.headers.get('X-Active-Persona') || personaId;
    if (personaId === 'ensemble' && activePersonaId && activePersonaId !== 'ensemble') {
      const nextIndex = personas.findIndex((p) => p && p.id === activePersonaId);
      if (nextIndex >= 0 && nextIndex !== personaIndex) {
        // Silent: don't flash a second tagline over the whisper; the
        // carousel motion itself is the signal that Ensemble switched.
        applyPersona(nextIndex, { silent: true });
      }
    }

    if (appConfig.enableWhisperMemory && predictedText) {
      whisperHistory.push(predictedText);
      if (whisperHistory.length > WHISPER_HISTORY_MAX) whisperHistory.shift();
    }

    setStatus('whispering');
    let echoRevealGen = null;
    if (appConfig.enableEchoReveal) {
      echoRevealGen = startEchoReveal(predictedText, isStale);
    } else {
      showCaptionInstant(predictedText);
    }
    activeWhisper = { token, personaId: activePersonaId, predictedText };

    await player.playStream(
      response,
      isStale,
      () => {
        if (!isStale()) {
          if (activeWhisper && activeWhisper.token === token) {
            reportEvent('whisper_completed', {
              persona: activePersonaId,
              requested_persona: personaId,
              predicted_text: predictedText,
            });
            activeWhisper = null;
          }
          setStatus('listening');
          if (appConfig.enableEchoReveal) {
            // Make sure the full whisper actually landed in the editor --
            // it's now just part of the document, closing the loop
            // (roadmap #10) -- no fade timer, nothing to hide.
            completeEchoReveal(echoRevealGen, predictedText);
          } else {
            hideCaptionSoon();
          }
        }
      }
    );
  }

  // ---------------------------------------------------------------------
  // Keystroke listener + debounce
  // ---------------------------------------------------------------------
  editor.addEventListener('keydown', () => player.primeAudioContext(), { once: true });

  editor.addEventListener('input', () => {
    // Typing resumed (or just started): kill anything currently
    // playing/in-flight instantly so it never fights the user's flow.
    invalidatePreviousRequest();
    player.stop({ fade: true });
    setStatus('listening');
    cancelEchoReveal();
    if (echoInsertion) {
      // Echo Mode was still mid-type -- remove the not-yet-committed AI
      // text, keeping whatever the user just typed (typing always wins).
      rollbackEchoInsertion();
    } else {
      hideCaptionSoon();
    }

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const paragraph = getCurrentParagraph(editor);
      if (paragraph.length >= MIN_CONTEXT_CHARS) {
        requestPrediction(paragraph);
      }
    }, DEBOUNCE_MS);
  });

  // ---------------------------------------------------------------------
  // InnerRap karaoke performance: keep the original draft in #editor,
  // render lyrics as word spans below, scroll into view, and highlight
  // each word in sync with the cloned-voice playback (same alignment
  // machinery as the voice-match test).
  // ---------------------------------------------------------------------
  const rapPerformanceEl = document.getElementById('rap-performance');
  const rapLyricsEl = document.getElementById('rap-lyrics');
  let rapAudioEl = null;
  let rapAudioUrl = null;
  let rapRafId = null;
  let rapWords = []; // [{text, start, end}]
  let rapLastActiveIndex = -1;

  function stopRapPerformance() {
    if (rapRafId) {
      cancelAnimationFrame(rapRafId);
      rapRafId = null;
    }
    if (rapAudioEl) {
      try {
        rapAudioEl.pause();
      } catch {
        /* no-op */
      }
      rapAudioEl = null;
    }
    if (rapAudioUrl) {
      URL.revokeObjectURL(rapAudioUrl);
      rapAudioUrl = null;
    }
    rapLastActiveIndex = -1;
    if (rapLyricsEl) {
      rapLyricsEl.querySelectorAll('.rap-word.active').forEach((el) => el.classList.remove('active'));
    }
  }

  function base64ToBlobUrl(base64, mime) {
    const byteChars = atob(base64);
    const byteNumbers = new Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
    const blob = new Blob([new Uint8Array(byteNumbers)], { type: mime });
    return URL.createObjectURL(blob);
  }

  function renderRapLyrics(lyrics, words) {
    if (!rapLyricsEl) return;
    rapLyricsEl.innerHTML = '';
    rapWords = words || [];
    let wordIdx = 0;
    // Preserve verse line breaks for readability; word indices still line up
    // with TTS alignment (whitespace-delimited, newlines count as whitespace).
    lyrics.split('\n').forEach((line) => {
      const lineEl = document.createElement('p');
      lineEl.className = 'mb-3 min-h-[1.2em]';
      const trimmed = line.trim();
      if (!trimmed) {
        rapLyricsEl.appendChild(lineEl);
        return;
      }
      trimmed.split(/\s+/).forEach((fallback, i) => {
        if (i > 0) lineEl.appendChild(document.createTextNode(' '));
        const span = document.createElement('span');
        span.className = 'rap-word';
        span.dataset.index = String(wordIdx);
        span.textContent = (rapWords[wordIdx] && rapWords[wordIdx].text) || fallback;
        wordIdx += 1;
        lineEl.appendChild(span);
      });
      rapLyricsEl.appendChild(lineEl);
    });
  }

  function startRapHighlightLoop() {
    if (!rapLyricsEl) return;
    const spans = rapLyricsEl.querySelectorAll('.rap-word');
    const tick = () => {
      if (!rapAudioEl) return;
      const t = rapAudioEl.currentTime;
      let activeIndex = -1;
      for (let i = 0; i < rapWords.length; i++) {
        if (t >= rapWords[i].start && t < rapWords[i].end) {
          activeIndex = i;
          break;
        }
      }
      if (activeIndex !== rapLastActiveIndex) {
        if (rapLastActiveIndex >= 0 && spans[rapLastActiveIndex]) {
          spans[rapLastActiveIndex].classList.remove('active');
        }
        if (activeIndex >= 0 && spans[activeIndex]) {
          spans[activeIndex].classList.add('active');
          spans[activeIndex].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
        rapLastActiveIndex = activeIndex;
      }
      if (rapAudioEl && !rapAudioEl.ended && !rapAudioEl.paused) {
        rapRafId = requestAnimationFrame(tick);
      } else {
        rapRafId = null;
      }
    };
    rapRafId = requestAnimationFrame(tick);
  }

  async function playRapPerformance({ lyrics, audio_base64, words, pitch_playback_rate }) {
    if (!rapPerformanceEl || !rapLyricsEl) return;
    stopRapPerformance();
    // Pause the ordinary whisper loop so it doesn't fight the performance.
    invalidatePreviousRequest();
    player.stop({ fade: true });

    renderRapLyrics(lyrics, words);
    rapPerformanceEl.classList.remove('hidden');
    // Auto-scroll to the rapping section; original draft stays above in #editor.
    rapPerformanceEl.scrollIntoView({ behavior: 'smooth', block: 'start' });

    rapAudioUrl = base64ToBlobUrl(audio_base64, 'audio/mpeg');
    rapAudioEl = new Audio(rapAudioUrl);
    const rate = typeof pitch_playback_rate === 'number' ? pitch_playback_rate : 1.0;
    rapAudioEl.preservesPitch = false;
    rapAudioEl.mozPreservesPitch = false;
    rapAudioEl.webkitPreservesPitch = false;
    rapAudioEl.playbackRate = rate;

    rapAudioEl.addEventListener('ended', () => {
      stopRapPerformance();
      setStatus('listening');
    });

    setStatus('whispering');
    try {
      await rapAudioEl.play();
      startRapHighlightLoop();
    } catch (err) {
      console.warn('[InnerVoice] rap performance playback failed', err);
      setStatus('listening');
    }
  }

  setStatus('listening');
  loadConfig();
  if (rapSongBtn) {
    rapSongBtn.addEventListener('click', async () => {
      const draft = editor.value.trim();
      if (draft.length < 40) {
        showPersonaTagline('Write a bit more first — then we can make a song.');
        return;
      }
      rapSongBtn.disabled = true;
      rapSongBtn.textContent = 'writing the song…';
      stopRapPerformance();
      try {
        const response = await fetch(RAP_SONG_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: draft }),
        });
        if (!response.ok) {
          let detail = 'Could not make a song just now.';
          try {
            const body = await response.json();
            detail = body.detail || detail;
          } catch {
            /* no-op */
          }
          showPersonaTagline(detail);
          return;
        }
        const body = await response.json();
        const lyrics = (body.lyrics || '').trim();
        if (!lyrics || !body.audio_base64) {
          showPersonaTagline('Song came back empty — try again with more writing.');
          return;
        }
        // Original draft stays untouched in #editor; lyrics live in the
        // karaoke pane below and get rapped with word highlighting.
        rapSongBtn.textContent = 'rapping…';
        await playRapPerformance(body);
        reportEvent('rap_song_generated', {
          chars: lyrics.length,
          words: (body.words || []).length,
        });
      } catch (err) {
        console.warn('[InnerVoice] rap song request failed', err);
        showPersonaTagline('Could not reach the song endpoint.');
      } finally {
        rapSongBtn.disabled = false;
        rapSongBtn.textContent = 'make a rap song';
      }
    });
  }

  // Typing during a rap performance cancels it (typing always wins).
  editor.addEventListener('input', () => {
    if (rapAudioEl) stopRapPerformance();
  });

  /** Hard-stop every InnerVoice output: rap karaoke, streamed whisper audio,
   * in-flight predicts, and Echo Mode typing. Partial echo text already in
   * the editor is kept (committed); only speaking/animation is cut. */
  function stopInnerVoice() {
    if (rapAudioEl) stopRapPerformance();
    invalidatePreviousRequest();
    player.stop({ fade: false });
    cancelEchoReveal();
    if (echoInsertion) {
      commitEchoInsertion();
    } else {
      hideCaptionSoon();
    }
    setStatus('listening');
  }

  // Click "whispering" to stop InnerVoice in any mode (rap, ensemble, etc.).
  if (statusChip) {
    statusChip.addEventListener('click', () => {
      if (currentStatus !== 'whispering') return;
      stopInnerVoice();
    });
  }

  loadPersonas();
})();
