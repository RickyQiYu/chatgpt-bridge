import { config } from '../../config.js';

export class TabObservationAdmission {
  constructor({ hub, sendCommand, releaseCoordinator = null, pendingUsesClient }) {
    this.hub = hub;
    this.sendCommand = sendCommand;
    this.releaseCoordinator = releaseCoordinator;
    this.pendingUsesClient = pendingUsesClient;
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

  async refreshStaleTabObservation(client = {}, state = {}) {
    if (!String(client.runtime || client.transport || '').trim()) return client;
    if (this.hasFreshTabObservation(client)) return client;
    const observation = client.tabObservation || {};
    const clientId = String(client.id || '');
    if (!clientId || !client.ready || client.compatible === false
      || client.compatibility?.compatible === false || client.quarantined
      || client.activeRequest?.requestId || observation.activeRequest?.requestId
      || this.releaseCoordinator?.isReleasePending?.(clientId)
      || this.pendingUsesClient(clientId, state.requestId || '')) {
      return client;
    }

    const previousObservedAt = Number(observation.observedAt) || 0;
    await this.sendCommand('tab.observation.refresh', { reason: 'prompt_admission' }, {
      sourceClientId: clientId,
      timeoutMs: 5_000,
    });
    const refreshed = Array.from(this.hub.clients || []).find((candidate) => candidate.id === clientId) || client;
    const refreshedAt = Number(refreshed.tabObservation?.observedAt) || 0;
    if (!this.hasFreshTabObservation(refreshed) || refreshedAt <= previousObservedAt) {
      const error = new Error(`No fresh tab observation was read back for ${clientId}`);
      error.code = 'TAB_OBSERVATION_REFRESH_FAILED';
      throw error;
    }
    return refreshed;
  }
}
