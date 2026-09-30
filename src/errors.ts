export type ErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'NON_NEGATIVE_VIOLATION'
  | 'NEGATIVE_DEMAND'
  | 'SECTOR_MISMATCH'
  | 'DUPLICATE_SECTOR'
  | 'NOT_PRODUCTIVE'
  | 'SINGULAR_MATRIX'
  | 'ILL_CONDITIONED'
  | 'IDEMPOTENCY_REPLAY'
  | 'PERSISTENCE';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }

  get httpStatus(): number {
    switch (this.code) {
      case 'VALIDATION':
      case 'NON_NEGATIVE_VIOLATION':
      case 'NEGATIVE_DEMAND':
      case 'SECTOR_MISMATCH':
      case 'DUPLICATE_SECTOR':
      case 'NOT_PRODUCTIVE':
      case 'SINGULAR_MATRIX':
      case 'ILL_CONDITIONED':
        return 422;
      case 'NOT_FOUND':
        return 404;
      case 'CONFLICT':
      case 'IDEMPOTENCY_REPLAY':
        return 409;
      default:
        return 500;
    }
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
