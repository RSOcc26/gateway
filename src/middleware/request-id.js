import { randomUUID } from 'node:crypto';

// A client-supplied X-Request-Id is reused only if it is short and safe to log and forward
const SAFE_ID = /^[A-Za-z0-9._-]{1,64}$/;

export const genRequestId = (req) => {
  const supplied = req.headers['x-request-id'];
  return typeof supplied === 'string' && SAFE_ID.test(supplied) ? supplied : randomUUID();
};
