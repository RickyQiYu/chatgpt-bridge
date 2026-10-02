// Exact request-lease release command handler.
(() => {
  'use strict';

  function createRequestReleaseCommand(deps = {}) {
    const {
      diagnostic,
      getActiveRequest,
      releaseRequest,
      settleReleaseCleanup,
    } = deps;

    async function handleRequestRelease(payload) {
      const requestId = String(payload.requestId || '');
      const commandId = String(payload.commandId || '');
      const releaseIdentity = {
        leaseId: String(payload.leaseId || ''),
        ownerServerInstanceId: String(payload.ownerServerInstanceId || ''),
      };
      const activeRequest = getActiveRequest();
      if (!activeRequest) {
        await settleReleaseCleanup({ commandId, requestId, status: 'completed', released: true, duplicate: true, ...releaseIdentity });
        return;
      }
      if (requestId && activeRequest.requestId !== requestId) {
        diagnostic('request.release_mismatch', { requestId, activeRequestId: activeRequest.requestId });
        await settleReleaseCleanup({
          commandId, requestId, status: 'failed',
          code: 'RELEASE_ACTIVE_REQUEST_MISMATCH',
          message: `Active request ${activeRequest.requestId} does not match release request`,
          evidence: { activeRequestId: activeRequest.requestId },
          ...releaseIdentity,
        });
        return;
      }
      const released = releaseRequest(activeRequest, String(payload.reason || payload.terminalCode || 'server_terminal'));
      await settleReleaseCleanup({ commandId, requestId, status: 'completed', released, ...releaseIdentity });
    }

    return Object.freeze({ handleRequestRelease });
  }

  globalThis.ChatGptRequestReleaseCommand = Object.freeze({ createRequestReleaseCommand });
})();
