// Sends an RFC 9457 problem document that includes the correlation ID
export const sendProblem = (reply, status, title, detail) => reply
  .code(status)
  .type('application/problem+json')
  .send({
    type: 'about:blank',
    title,
    status,
    ...(detail && { detail }),
    correlationId: reply.request.id,
  });
