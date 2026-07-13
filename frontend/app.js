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
  ];

  // ---------------------------------------------------------------------
  // DOM refs
  // ---------------------------------------------------------------------
  const editor = document.getElementById('editor');
  const statusDot = document.getElementById('status-dot');
  const statusLabel = document.getElementById('status-label');
  const captionEl = document.getElementById('whisper-caption');
  const wordmarkEl = document.getElementById('wordmark');
  const personaCarouselEl = document.getElementById('persona-carousel');
  const personaCarouselTrackEl = document.getElementById('persona-carousel-track');
  const personaTaglineEl = document.getElementById('persona-tagline');

  // ---------------------------------------------------------------------
  // Status indicator (tiny, top-right — never intrusive)
  // ---------------------------------------------------------------------
  const STATUS_STYLES = {
    listening: { dot: 'bg-neutral-600', animate: false, label: 'listening' },
    thinking: { dot: 'bg-amber-400', animate: true, label: 'thinking' },
    whispering: { dot: 'bg-emerald-400', animate: true, label: 'whispering' },
  };

  function setStatus(state) {
    const style = STATUS_STYLES[state] || STATUS_STYLES.listening;
    statusDot.className = `w-1.5 h-1.5 rounded-full transition-colors ${style.dot} ${
      style.animate ? 'animate-pulse-soft' : ''
    }`;
    statusLabel.textContent = style.label;
  }

  let captionTimer = null;
  function showCaption(text) {
    if (!text) return;
    clearTimeout(captionTimer);
    captionEl.textContent = `“${text}”`;
    captionEl.classList.remove('animate-fade-in');
    // eslint-disable-next-line no-unused-expressions
    captionEl.offsetHeight; // restart the fade-in animation
    captionEl.classList.add('animate-fade-in');
    captionEl.style.opacity = '1';
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

  function applyPersona(index, { silent = false } = {}) {
    const clamped = Math.max(0, Math.min(personas.length - 1, index));
    personaIndex = clamped;
    const persona = personas[personaIndex];
    if (!persona) return;

    liveOffset = offsetForIndex(personaIndex);
    personaCarouselTrackEl.style.transform = `translateY(${liveOffset}px)`;
    if (!silent) showPersonaTagline(persona.tagline);

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
    }

    /** Call this as early as possible (e.g. first keydown) to capture the
     * browser's "user activation" window needed to unlock audio playback. */
    primeAudioContext() {
      this._ensureContext();
    }

    _ensureContext() {
      if (!this.audioCtx) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        this.audioCtx = new Ctx();
        this.audioEl = new Audio();
        this.audioEl.preload = 'auto';
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

  function invalidatePreviousRequest() {
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

    let response;
    try {
      response = await fetch(PREDICT_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: contextText, persona: currentPersonaId() }),
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

    setStatus('whispering');
    showCaption(predictedText);

    await player.playStream(
      response,
      isStale,
      () => {
        if (!isStale()) {
          setStatus('listening');
          hideCaptionSoon();
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
    hideCaptionSoon();

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const paragraph = getCurrentParagraph(editor);
      if (paragraph.length >= MIN_CONTEXT_CHARS) {
        requestPrediction(paragraph);
      }
    }, DEBOUNCE_MS);
  });

  setStatus('listening');
  loadPersonas();
})();
