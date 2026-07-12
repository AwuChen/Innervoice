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
  const CAPTION_VISIBLE_MS = 4500;

  // ---------------------------------------------------------------------
  // DOM refs
  // ---------------------------------------------------------------------
  const editor = document.getElementById('editor');
  const statusDot = document.getElementById('status-dot');
  const statusLabel = document.getElementById('status-label');
  const captionEl = document.getElementById('whisper-caption');

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
        body: JSON.stringify({ text: contextText }),
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
})();
