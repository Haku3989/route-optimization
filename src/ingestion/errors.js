/**
 * Ingestion-layer error types.
 *
 * `IngestionError` is a small `Error` subclass that carries an HTTP status so
 * route handlers can translate ingestion failures into consistent responses
 * (mirrors the `AuthError` pattern used by the driver auth layer). It is kept
 * in its own module so routes can import it cleanly without pulling in the
 * ExcelJS-dependent parser.
 */

export class IngestionError extends Error {
  /**
   * @param {string} message  human-readable, client-safe description
   * @param {number} [status] HTTP status the route should surface (default 400)
   */
  constructor(message, status = 400) {
    super(message);
    this.name = "IngestionError";
    this.status = status;
  }
}
