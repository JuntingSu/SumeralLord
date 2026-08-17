import type { FastifyReply } from 'fastify';
import type { ApiEnvelope, ErrorCode } from '@dl/shared';

export function ok<T>(reply: FastifyReply, data?: T, message?: string): FastifyReply {
  const body: ApiEnvelope<T> = {
    success: true,
    ...(data !== undefined ? { data } : {}),
    ...(message ? { message } : {}),
  };
  return reply.status(200).send(body);
}

export function fail(reply: FastifyReply, statusCode: number, code: ErrorCode, message: string): FastifyReply {
  const body: ApiEnvelope = { success: false, code, message };
  return reply.status(statusCode).send(body);
}
