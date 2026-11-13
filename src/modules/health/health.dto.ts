import type { SuccessResponseBody } from '../../shared/api-response.js';

export interface LivenessDto {
  status: 'ok';
  /** ISO 8601 UTC timestamp of when the probe was answered. */
  timestamp: string;
}

export interface ReadinessDto {
  status: 'ready';
  checks: { database: 'connected' };
}

export type LivenessResponseBody = SuccessResponseBody<LivenessDto>;
export type ReadinessResponseBody = SuccessResponseBody<ReadinessDto>;
