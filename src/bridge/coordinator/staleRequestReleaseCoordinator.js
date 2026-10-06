import { config } from '../../config.js';
import { isRequestRuntimeFinished } from './requestRuntimeProjection.js';

const IDENTITY_FIELDS = Object.freeze([
  'requestId',
  'clientId',
  'leaseId',
  'ownerServerInstanceId',
  'responseEpoch',
]);
const LEASE_IDENTITY_FIELDS = Object.freeze([
  'requestId',
  'leaseId',
  'ownerServerInstanceId',
  'responseEpoch',
]);
const TERMINAL_LIFECYCLES = new Set(['completed', 'failed', 'cancelled']);

function exactInputIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== IDENTITY_FIELDS.length || keys.some((key) => typeof key !== 'string' || !IDENTITY_FIELDS.includes(key))) return null;
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return null;
  for (const field of ['requestId', 'clientId', 'leaseId', 'ownerServerInstanceId']) {
    if (typeof value[field] !== 'string' || !value[field].trim()) return null;
  }
  if (!Number.isSafeInteger(value.responseEpoch) || value.responseEpoch < 0) return null;
  return value;
}

function hasLeaseIdentity(value) {
  return Boolean(value && typeof value === 'object'
    && typeof value.requestId === 'string' && value.requestId.trim()
    && typeof value.leaseId === 'string' && value.leaseId.trim()
    && typeof value.ownerServerInstanceId === 'string' && value.ownerServerInstanceId.trim()
    && Number.isSafeInteger(value.responseEpoch) && value.responseEpoch >= 0);
}

function sameLeaseIdentity(left, right) {
  return hasLeaseIdentity(left) && hasLeaseIdentity(right)
    && LEASE_IDENTITY_FIELDS.every((field) => left[field] === right[field]);
}

function hasFreshObservationTimestamp(observation, now, freshnessMs) {
  if (!observation || typeof observation !== 'object' || Array.isArray(observation)) return false;
  const observerId = typeof observation.observerId === 'string' ? observation.observerId.trim() : '';
  const revision = observation.revision;
  const observedAt = observation.observedAt;
  return Boolean(observerId
    && Number.isSafeInteger(revision) && revision > 0
    && typeof observedAt === 'number' && Number.isFinite(observedAt)
    && observedAt > 0 && observedAt <= now
    && now - observedAt <= freshnessMs);
}

function validObservation(observation, now, freshnessMs) {
  if (!hasFreshObservationTimestamp(observation, now, freshnessMs)) return false;
  const generation = typeof observation.generation === 'string'
    ? observation.generation
    : observation.generation?.state;
  return generation === 'idle' || generation === 'stopped'
    ? observation.composer?.ready === true
      && observation.composer?.primaryAction === 'voice'
      && observation.composer?.hasDraft === false
      && observation.document?.chatMainReady === true
      && observation.document?.pageReady === true
      && Number(observation.stableForMs) >= 750
    : false;
}

function rejected(reason) {
  return { status: 'rejected', reason };
}

function attemptKey(identity) {
  return [identity.clientId, ...LEASE_IDENTITY_FIELDS.map((field) => String(identity[field] ?? ''))].join('\u001f');
}

/**
 * Performs one exact stale-lease cleanup after proving that the owning tab is
 * ready, still reports the same persisted lease, and has a fresh Voice-idle
 * composer observation. A stopped generation alone is insufficient because
 * the composer may still contain an unsent draft.
 * It does not change canonical request state and never retries a release.
 */
export class StaleRequestReleaseCoordinator {
  constructor({
    activeRequestCandidates,
    serverInstanceId,
    pending,
    isReleasePending,
    hasPendingCommandForClient = () => false,
    getCanonicalRequestState,
    sendCommand,
    now = () => Date.now(),
    observationFreshnessMs = config.clientStaleMs,
  } = {}) {
    if (typeof activeRequestCandidates !== 'function'
      || typeof isReleasePending !== 'function'
      || typeof getCanonicalRequestState !== 'function'
      || typeof sendCommand !== 'function'
      || !pending || typeof pending.values !== 'function') {
      throw new TypeError('StaleRequestReleaseCoordinator requires candidates, pending requests, release state, canonical lookup, and sendCommand');
    }
    this.activeRequestCandidates = activeRequestCandidates;
    this.serverInstanceId = String(serverInstanceId || '').trim();
    this.pending = pending;
    this.isReleasePending = isReleasePending;
    this.hasPendingCommandForClient = typeof hasPendingCommandForClient === 'function'
      ? hasPendingCommandForClient
      : () => false;
    this.getCanonicalRequestState = getCanonicalRequestState;
    this.sendCommand = sendCommand;
    this.now = typeof now === 'function' ? now : () => Date.now();
    const freshness = Number(observationFreshnessMs);
    this.observationFreshnessMs = Number.isFinite(freshness) && freshness > 0
      ? freshness
      : Number(config.clientStaleMs) || 30_000;
    this.releaseAttempts = new Set();
  }

  async releaseStaleRequestLease(input, { clientSnapshot = null } = {}) {
    const identity = exactInputIdentity(input);
    if (!identity) return rejected('invalid_identity');
    if (!this.serverInstanceId) return rejected('server_instance_missing');
    const releaseKey = attemptKey(identity);
    if (this.releaseAttempts.has(releaseKey)) return rejected('release_already_attempted');

    let candidates;
    try { candidates = this.activeRequestCandidates(); } catch { return rejected('candidate_lookup_failed'); }
    if (!Array.isArray(candidates)) return rejected('candidate_lookup_failed');

    const findCandidate = (values) => {
      if (!Array.isArray(values)) return null;
      const clientCandidates = values.filter((candidate) => candidate?.clientId === identity.clientId);
      const requestCandidates = values.filter((candidate) => candidate?.activeRequest?.requestId === identity.requestId);
      if (clientCandidates.length !== 1 || requestCandidates.length !== 1 || clientCandidates[0] !== requestCandidates[0]) return null;
      return clientCandidates[0];
    };

    let candidate = findCandidate(candidates);
    if (!candidate) return rejected('candidate_ambiguous_or_missing');
    if (clientSnapshot && String(clientSnapshot.id || '') !== identity.clientId) {
      return rejected('candidate_client_mismatch');
    }
    let client = clientSnapshot
      ? { ...candidate?.client, ...clientSnapshot }
      : candidate?.client;
    if (!client || client.id !== identity.clientId || client.ready !== true
      || client.compatible === false || client.compatibility?.compatible === false) {
      return rejected('client_not_ready_or_compatible');
    }
    let observation = client.tabObservation;
    const tabActiveRequest = observation?.activeRequest;
    if (!sameLeaseIdentity(candidate.activeRequest, identity)
      || !sameLeaseIdentity(client.activeRequest, candidate.activeRequest)
      || !sameLeaseIdentity(tabActiveRequest, candidate.activeRequest)) {
      return rejected('client_tab_lease_mismatch');
    }

    for (const state of this.pending.values()) {
      if (state?.clientId === identity.clientId && !isRequestRuntimeFinished(state)) {
        return rejected('active_pending_request');
      }
    }
    if (this.isReleasePending(identity.clientId)) return rejected('release_pending');

    let canonical;
    try {
      canonical = this.getCanonicalRequestState(identity.requestId);
    } catch {
      return rejected('canonical_lookup_failed');
    }
    if (canonical) {
      const canonicalIdentity = {
        requestId: canonical.requestId,
        leaseId: canonical.source?.leaseId,
        ownerServerInstanceId: canonical.source?.ownerServerInstanceId,
        responseEpoch: canonical.response?.epoch,
      };
      if (!sameLeaseIdentity(canonicalIdentity, identity)) return rejected('canonical_lease_mismatch');
      if (!canonical.terminal || !TERMINAL_LIFECYCLES.has(String(canonical.lifecycle || ''))) {
        return rejected('canonical_request_not_terminal');
      }
    } else if (identity.ownerServerInstanceId === this.serverInstanceId) {
      return rejected('current_owner_canonical_state_missing');
    }

    const now = this.now();
    if (typeof now !== 'number' || !Number.isFinite(now)) return rejected('clock_invalid');
    if (!validObservation(observation, now, this.observationFreshnessMs)) {
      if (hasFreshObservationTimestamp(observation, now, this.observationFreshnessMs)) {
        return rejected('observation_not_fresh_and_idle');
      }
      if (this.hasPendingCommandForClient(identity.clientId)) return rejected('bridge_command_pending');

      const previousSessionId = String(client.session?.id || '');
      try {
        await this.sendCommand('tab.observation.refresh', { reason: 'stale_lease_release' }, {
          sourceClientId: identity.clientId,
          timeoutMs: 5_000,
        });
      } catch {
        return rejected('observation_refresh_failed');
      }

      try { candidates = this.activeRequestCandidates(); } catch { return rejected('candidate_lookup_failed'); }
      candidate = findCandidate(candidates);
      if (!candidate) return rejected('candidate_ambiguous_or_missing');
      client = candidate.client;
      observation = client?.tabObservation;
      if (!client || client.id !== identity.clientId || client.ready !== true
        || client.compatible === false || client.compatibility?.compatible === false) {
        return rejected('client_not_ready_or_compatible');
      }
      if (clientSnapshot && String(clientSnapshot.id || '') !== client.id) return rejected('candidate_client_mismatch');
      if (previousSessionId && String(client.session?.id || '') !== previousSessionId) {
        return rejected('candidate_session_mismatch');
      }
      if (!sameLeaseIdentity(candidate.activeRequest, identity)
        || !sameLeaseIdentity(client.activeRequest, identity)
        || !sameLeaseIdentity(observation?.activeRequest, identity)
        || !sameLeaseIdentity(observation?.boundLeaseProjection, identity)) {
        return rejected('client_tab_lease_mismatch');
      }
      for (const state of this.pending.values()) {
        if (state?.clientId === identity.clientId && !isRequestRuntimeFinished(state)) {
          return rejected('active_pending_request');
        }
      }
      if (this.isReleasePending(identity.clientId)) return rejected('release_pending');
      if (this.hasPendingCommandForClient(identity.clientId)) return rejected('bridge_command_pending');

      let refreshedCanonical;
      try { refreshedCanonical = this.getCanonicalRequestState(identity.requestId); } catch { return rejected('canonical_lookup_failed'); }
      if (refreshedCanonical) {
        const canonicalIdentity = {
          requestId: refreshedCanonical.requestId,
          leaseId: refreshedCanonical.source?.leaseId,
          ownerServerInstanceId: refreshedCanonical.source?.ownerServerInstanceId,
          responseEpoch: refreshedCanonical.response?.epoch,
        };
        if (!sameLeaseIdentity(canonicalIdentity, identity)) return rejected('canonical_lease_mismatch');
        if (!refreshedCanonical.terminal
          || !TERMINAL_LIFECYCLES.has(String(refreshedCanonical.lifecycle || ''))) {
          return rejected('canonical_request_not_terminal');
        }
      } else if (identity.ownerServerInstanceId === this.serverInstanceId) {
        return rejected('current_owner_canonical_state_missing');
      }

      const refreshedAt = this.now();
      if (typeof refreshedAt !== 'number' || !Number.isFinite(refreshedAt)
        || !validObservation(observation, refreshedAt, this.observationFreshnessMs)) {
        return rejected('observation_refresh_unconfirmed');
      }
    }
    if (this.releaseAttempts.has(releaseKey)) return rejected('release_already_attempted');

    const request = {
      requestId: identity.requestId,
      leaseId: identity.leaseId,
      ownerServerInstanceId: identity.ownerServerInstanceId,
      responseEpoch: identity.responseEpoch,
    };
    if (this.releaseAttempts.size >= 500) this.releaseAttempts.delete(this.releaseAttempts.values().next().value);
    this.releaseAttempts.add(releaseKey);
    try {
      const result = await this.sendCommand('request.release', {
        requestId: identity.requestId,
        recoveryMode: 'stale_lease',
        reason: 'stale_lease_release',
        terminalCode: 'stale_lease_release',
      }, {
        sourceClientId: identity.clientId,
        timeoutMs: 10_000,
        request,
      });
      if (result?.type === 'lease.released' && result.released === true) {
        return { status: 'confirmed', result };
      }
      return { status: 'ambiguous', reason: 'release_unconfirmed' };
    } catch (error) {
      if (error?.preDispatchRejected === true) {
        this.releaseAttempts.delete(releaseKey);
        return rejected('release_rejected_before_dispatch');
      }
      return {
        status: 'ambiguous',
        reason: 'release_command_failed',
        message: String(error?.message || error || 'Release command failed'),
      };
    }
  }
}
