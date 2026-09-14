/**
 * Typed HTTP-ish errors thrown by Harvestlink services.
 * Routes catch these and map `status` to Express responses without embedding HTTP in services.
 */
export class AppError extends Error {
  readonly status: number;
  readonly details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.details = details;
  }
}
