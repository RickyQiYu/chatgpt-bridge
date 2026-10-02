export function scheduleTerminalIdleLeaseRelease({
  pending,
  releaseStaleRequestLease,
  eventBus,
  clientId,
  client = {},
  observation = null,
} = {}) {
  const activeRequest = observation?.activeRequest || null;
  const sourceClientId = String(clientId || '');
  if (typeof releaseStaleRequestLease !== 'function' || !activeRequest?.requestId || !sourceClientId) return;
  if (pending.has(String(activeRequest.requestId))) return;
  if (observation.composer?.primaryAction !== 'voice'
      || observation.composer?.ready !== true
      || observation.composer?.hasDraft !== false
      || !['idle', 'stopped'].includes(String(observation.generation?.state || ''))
      || Number(observation.stableForMs) < 750) return;

  const identity = {
    requestId: String(activeRequest.requestId),
    clientId: sourceClientId,
    leaseId: String(activeRequest.leaseId || ''),
    ownerServerInstanceId: String(activeRequest.ownerServerInstanceId || ''),
    responseEpoch: Number(activeRequest.responseEpoch),
  };
  if (!identity.leaseId || !identity.ownerServerInstanceId || !Number.isSafeInteger(identity.responseEpoch)) return;

  setImmediate(() => {
    const clientSnapshot = { ...client, activeRequest, tabObservation: observation };
    Promise.resolve(releaseStaleRequestLease(identity, clientSnapshot)).catch((error) => {
      eventBus?.emitDebug({
        type: 'request.stale_idle_release.failed',
        requestId: identity.requestId,
        clientId: identity.clientId,
        data: {
          code: String(error?.code || ''),
          message: String(error?.message || error || 'Stale release failed'),
        },
      });
    });
  });
}
