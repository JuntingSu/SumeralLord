import jwt from 'jsonwebtoken';
import { AUTH } from '@dl/shared';
import { config } from '../config.js';

export interface AuthTokenPayload {
  userId: number;
  username: string;
  iat?: number;
  exp?: number;
}

export function signAuthToken(payload: { userId: number; username: string }): string {
  return jwt.sign(payload, config.jwtSecret, { expiresIn: AUTH.JWT_EXPIRES_IN });
}

export function verifyAuthToken(token: string): AuthTokenPayload | null {
  try {
    const decoded = jwt.verify(token, config.jwtSecret);
    if (typeof decoded === 'string') return null;
    return decoded as AuthTokenPayload;
  } catch {
    return null;
  }
}

export function authenticateBearer(authorizationHeader: string | undefined): AuthTokenPayload | null {
  if (!authorizationHeader?.startsWith('Bearer ')) return null;
  return verifyAuthToken(authorizationHeader.slice(7).trim());
}
