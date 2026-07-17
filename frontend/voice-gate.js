/**
 * voice-gate.js
 * -------------
 * Small bootstrap script for the main editor page: checks whether the user
 * still needs to go through voice onboarding, and if so, sends them to
 * `/onboarding.html` (a dedicated page, not a popup) before they can start
 * typing. Once onboarding is done (or explicitly skipped), this just gets
 * out of the way and `app.js` runs as normal.
 */

(() => {
  'use strict';

  const PROFILE_ENDPOINT = '/api/voice/profile';
  const SKIP_STORAGE_KEY = 'innervoice.onboardingSkipped';

  const setupBtn = document.getElementById('setup-voice-btn');
  const editorEl = document.getElementById('editor');

  async function init() {
    // Hold the editor until we know whether a redirect is coming, so a fast
    // typist can't sneak a keystroke in right before navigation happens.
    if (editorEl) editorEl.disabled = true;

    let profile;
    try {
      const response = await fetch(PROFILE_ENDPOINT);
      if (!response.ok) throw new Error(`profile fetch failed: ${response.status}`);
      profile = await response.json();
    } catch (err) {
      console.warn('[InnerVoice] could not load voice profile', err);
      if (editorEl) editorEl.disabled = false;
      return;
    }

    if (!profile.supported) {
      if (editorEl) editorEl.disabled = false;
      return; // no ElevenLabs configured; onboarding isn't offered at all.
    }

    if (setupBtn) {
      setupBtn.classList.remove('hidden');
      setupBtn.textContent = profile.has_voice ? 're-record voice' : 'set up voice';
      setupBtn.addEventListener('click', () => {
        window.location.href = '/onboarding.html';
      });
    }

    const skipped = localStorage.getItem(SKIP_STORAGE_KEY) === '1';
    if (!profile.has_voice && !skipped) {
      window.location.href = '/onboarding.html';
      return;
    }

    if (editorEl) editorEl.disabled = false;
  }

  // This script tag sits at the end of <body>, so the DOM is already parsed.
  init();
})();
