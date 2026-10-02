// Readiness boundary for steering while an existing answer finishes.
(() => {
  'use strict';

  function createSteerComposerReadiness(deps = {}) {
    const {
      composerSubmissionText,
      composerTextValue,
      diagnostic,
      findChatMain,
      findComposer,
      findComposerRootStrict,
      hasComposerDraft,
      readPrimaryComposerAction,
    } = deps;

    function waitForVoiceIdle(request, timeoutMs = 90_000) {
      const started = Date.now();
      const limit = Math.max(2_000, Number(timeoutMs) || 90_000);
      const target = findComposerRootStrict() || findChatMain() || document.body || document.documentElement;
      return new Promise((resolve, reject) => {
        let observer = null;
        let timer = null;
        let settled = false;
        let lastDiagnosticAt = 0;
        let voiceSince = 0;
        let voiceComposer = null;

        const cleanup = () => {
          observer?.disconnect?.();
          if (timer) clearTimeout(timer);
        };
        const finish = (error, composer = null) => {
          if (settled) return;
          settled = true;
          cleanup();
          if (error) reject(error);
          else resolve(composer);
        };
        const failNotReady = (message) => {
          const error = new Error(message);
          error.code = 'STEER_SUBMIT_NOT_READY';
          error.retryable = true;
          error.provenNotExecuted = true;
          error.cancellationEvidence = { source: 'composer', reason: 'steer_composer_not_idle' };
          finish(error);
        };
        const inspect = () => {
          if (settled) return;
          if (timer) clearTimeout(timer);
          timer = null;
          const composer = findComposer();
          if (!composer || hasComposerDraft() || composerSubmissionText(composerTextValue(composer))) {
            const error = new Error('PROMPT_COMPOSER_NOT_IDLE: preserving the draft while steering waits for generation to finish');
            error.code = 'PROMPT_COMPOSER_NOT_IDLE';
            error.provenNotExecuted = true;
            finish(error);
            return;
          }

          const now = Date.now();
          const action = readPrimaryComposerAction();
          if (action === 'voice') {
            if (voiceComposer !== composer) {
              voiceComposer = composer;
              voiceSince = now;
            }
            const stableForMs = now - voiceSince;
            if (stableForMs >= 750) {
              diagnostic('steer.composer_idle.ready', { requestId: request?.requestId || '', waitedMs: now - started, stableForMs });
              finish(null, composer);
              return;
            }
            if (now - started >= limit) {
              failNotReady(`STEER_SUBMIT_NOT_READY: ChatGPT did not return to stable Voice idle within ${limit}ms`);
              return;
            }
            timer = setTimeout(inspect, Math.min(100, 750 - stableForMs, limit - (now - started)));
            return;
          }

          voiceSince = 0;
          voiceComposer = null;
          if (now - started >= limit) {
            failNotReady(`STEER_SUBMIT_NOT_READY: ChatGPT did not return to Voice idle within ${limit}ms`);
            return;
          }
          if (!lastDiagnosticAt || now - lastDiagnosticAt >= 2_000) {
            lastDiagnosticAt = now;
            diagnostic('steer.composer_idle.waiting', {
              requestId: request?.requestId || '',
              waitedMs: now - started,
              timeoutMs: limit,
              primaryAction: action,
            });
          }
          timer = setTimeout(inspect, Math.min(100, limit - (now - started)));
        };

        if (target && typeof MutationObserver === 'function') {
          observer = new MutationObserver(() => inspect());
          observer.observe(target, {
            subtree: true,
            childList: true,
            characterData: true,
            attributes: true,
            attributeFilter: ['aria-disabled', 'aria-hidden', 'aria-label', 'class', 'data-state', 'data-testid', 'disabled', 'hidden', 'style', 'title'],
          });
        }
        inspect();
      });
    }

    return Object.freeze({ waitForVoiceIdle });
  }

  globalThis.ChatGptSteerComposerReadiness = Object.freeze({ createSteerComposerReadiness });
})();
