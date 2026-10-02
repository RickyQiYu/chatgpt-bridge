import { config } from '../../config.js';

export function voiceIdleReleaseEvidenceIsCurrent(evidence, request, now = Date.now()) {
  if (!evidence || typeof evidence !== 'object') return false;
  const observedAt = Number(evidence.observedAt);
  const freshnessMs = Math.max(1_000, Number(config.clientStaleMs) || 30_000);
  return Boolean(
    String(evidence.observerId || '').trim()
    && Number.isSafeInteger(Number(evidence.revision)) && Number(evidence.revision) > 0
    && Number.isFinite(observedAt) && observedAt > 0 && observedAt <= now && now - observedAt <= freshnessMs
    && Number(evidence.stableForMs) >= 750
    && evidence.requestId === request?.requestId
    && evidence.leaseId === request?.leaseId
    && evidence.ownerServerInstanceId === request?.ownerServerInstanceId
    && Number(evidence.responseEpoch) === Number(request?.responseEpoch)
    && evidence.composerReady === true
    && evidence.composerAction === 'voice'
    && evidence.composerHasDraft === false
    && evidence.pageReady === true
    && evidence.chatMainReady === true
    && ['idle', 'stopped'].includes(String(evidence.generation || ''))
  );
}
