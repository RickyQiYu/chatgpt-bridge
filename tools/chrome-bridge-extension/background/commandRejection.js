import { MessageType } from './protocolV5.js';

const REASON_CODE_PATTERN = /^[a-z][a-z0-9_]{0,79}$/;

export async function rejectCommand({
  state,
  envelope,
  payload,
  sendProtocolMessage,
  message,
  code = 'BROWSER_COMMAND_REJECTED',
  preDispatchRejected = false,
  reasonCode = '',
  existingCommandId = '',
}) {
  const request = envelope.request || null;
  const body = {
    commandId: payload.commandId,
    requestId: request?.requestId || '',
    code,
    message,
    error: message,
  };
  if (preDispatchRejected) {
    body.preDispatchRejected = true;
    const boundedReasonCode = REASON_CODE_PATTERN.test(String(reasonCode || ''))
      ? String(reasonCode)
      : '';
    if (boundedReasonCode) body.reasonCode = boundedReasonCode;
    if (request) {
      body.leaseId = String(request.leaseId || '');
      body.ownerServerInstanceId = String(request.ownerServerInstanceId || '');
      body.responseEpoch = Number(request.responseEpoch) || 0;
    }
  }
  if (existingCommandId) body.existingCommandId = String(existingCommandId);
  await sendProtocolMessage(state, MessageType.COMMAND_REJECTED, body, {
    commandId: payload.commandId,
    causationId: envelope.messageId,
    lease: request,
  });
}
