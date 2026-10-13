import { config } from '../../config.js';

export class TabObservationAdmission {
  constructor({ hub, sendCommand, releaseCoordinator = null, pendingUsesClient, hasPendingCommandForClient = () => false }) {
    this.hub = hub;
    this.sendCommand = sendCommand;
    this.releaseCoordinator = releaseCoordinator;
    this.pendingUsesClient = pendingUsesClient;
    this.hasPendingCommandForClient = hasPendingCommandForClient;
  }

  hasFreshTabObservation(client = {}) {
    const observation = client.tabObservation || {};
    const observedAt = Number(observation.observedAt);
    const now = Date.now();
    const freshnessMs = Math.max(1_000, Number(config.clientStaleMs) || 30_000);
    return Number.isFinite(observedAt) && observedAt > 0 && observedAt <= now && now - observedAt <= freshnessMs;
  }

  hasFreshVoiceIdleComposer(client = {}) {
    if (!String(client.runtime || client.transport || '').trim()) return true;
    const observation = client.tabObservation || {};
    return Boolean(
      this.hasFreshTabObservation(client)
      && Number(observation.stableForMs) >= 750
      && observation.document?.pageReady === true
      && observation.document?.chatMainReady === true
      && observation.composer?.ready === true
      && observation.composer?.primaryAction === 'voice'
      && observation.composer?.hasDraft === false
      && ['idle', 'stopped'].includes(String(observation.generation?.state || ''))
    );
  }

  canWaitForComposerStability(client = {}, state = {}) {
    const observation = client.tabObservation || {};
    const clientId = String(client.id || '');
    return Boolean(
      clientId
      && client.ready
      && client.compatible !== false
      && client.compatibility?.compatible !== false
      && !client.quarantined
      && !client.activeRequest?.requestId
      && !observation.activeRequest?.requestId
      && !this.releaseCoordinator?.isReleasePending?.(clientId)
      && !this.pendingUsesClient(clientId, state.requestId || '')
      && !this.hasPendingCommandForClient(clientId)
      && this.hasFreshTabObservation(client)
      && Number(observation.stableForMs || 0) < 750
      && observation.document?.pageReady === true
      && observation.document?.chatMainReady === true
      && observation.composer?.ready === true
      && observation.composer?.primaryAction === 'voice'
      && observation.composer?.hasDraft === false
      && ['idle', 'stopped'].includes(String(observation.generation?.state || ''))
    );
  }

  async refreshStaleTabObservation(client = {}, state = {}) {
    if (!String(client.runtime || client.transport || '').trim()) return client;
    if (this.hasFreshTabObservation(client)) return client;
    const observation = client.tabObservation || {};
    const clientId = String(client.id || '');
    if (!clientId || !client.ready || client.compatible === false
      || client.compatibility?.compatible === false || client.quarantined
      || client.activeRequest?.requestId || observation.activeRequest?.requestId
      || this.releaseCoordinator?.isReleasePending?.(clientId)
      || this.hasPendingCommandForClient(clientId)
      || this.pendingUsesClient(clientId, state.requestId || '')) {
      return client;
    }

    try {
      await this.refreshTabObservation(client, { reason: 'prompt_admission' });
    } catch (error) {
      if (error?.code === 'TAB_OBSERVATION_REFRESH_NOT_FRESH') error.code = 'TAB_OBSERVATION_REFRESH_FAILED';
      throw error;
    }
    return Array.from(this.hub.clients || []).find((candidate) => candidate.id === clientId) || client;
  }

  async refreshTabObservation(client = {}, options = {}) {
    const clientId = String(client.id || '').trim();
    if (!clientId) throw tabObservationError('TAB_OBSERVATION_SOURCE_REQUIRED', 'sourceClientId is required');
    if (client.ready !== true || client.compatible === false
      || client.compatibility?.compatible === false || client.quarantined) {
      throw tabObservationError('TAB_OBSERVATION_CLIENT_UNAVAILABLE', 'The requested source client is unavailable');
    }

    const previousObservation = client.tabObservation || {};
    const previousRevision = Number(previousObservation.revision) || 0;
    const previousObservedAt = Number(previousObservation.observedAt) || 0;
    let result;
    try {
      result = await this.sendCommand('tab.observation.refresh', {
        reason: String(options.reason || 'recovery'),
      }, {
        sourceClientId: clientId,
        timeoutMs: Math.max(1_000, Number(options.timeoutMs) || 5_000),
      });
    } catch {
      throw tabObservationError('TAB_OBSERVATION_REFRESH_FAILED', 'Tab observation refresh could not be confirmed');
    }

    if (result?.type !== 'tab.observation.refreshed'
      || String(result.sourceClientId || '') !== clientId) {
      throw tabObservationError('TAB_OBSERVATION_REFRESH_FAILED', 'Tab observation refresh could not be confirmed');
    }

    const refreshed = Array.from(this.hub.clients || []).find((candidate) => candidate?.id === clientId);
    if (!refreshed) throw tabObservationError('TAB_OBSERVATION_CLIENT_NOT_FOUND', 'The requested source client disconnected');
    const observation = refreshed.tabObservation || {};
    const revision = Number(observation.revision) || 0;
    const observedAt = Number(observation.observedAt) || 0;
    const resultRevision = Number(result.revision) || 0;
    const resultObservedAt = Number(result.observedAt) || 0;
    if (!this.hasFreshTabObservation(refreshed)
      || revision <= previousRevision
      || observedAt <= previousObservedAt
      || resultRevision <= previousRevision
      || resultObservedAt <= previousObservedAt
      || revision < resultRevision
      || observedAt < resultObservedAt) {
      throw tabObservationError('TAB_OBSERVATION_REFRESH_NOT_FRESH', 'No newer fresh tab observation was confirmed');
    }
    return { sourceClientId: clientId, observation };
  }
}

function tabObservationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
