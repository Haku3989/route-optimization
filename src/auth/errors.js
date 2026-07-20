/**
 * Auth-layer error types.
 *
 * `AuthError` is a small `Error` subclass that carries an HTTP status so the
 * driver service and route handlers can translate authentication failures into
 * consistent responses (mirrors the `IngestionError` pattern in
 * `src/ingestion/errors.js`). It is kept in its own module so routes/services
 * can import it without pulling in `node:crypto`.
 *
 * Security note (Requirement 10.2): the default message is a SINGLE generic
 * string that does not reveal whether the username or the password was wrong.
 * Every authentication failure (unknown username, bad password, malformed
 * input) should throw `new AuthError()` so the two failure modes are
 * indistinguishable to a caller.
 */

/** The single generic denial message shared by every auth failure (Req 10.2). */
export const GENERIC_AUTH_MESSAGE = "invalid username or password";

export class AuthError extends Error {
  /**
   * @param {string} [message] client-safe description (defaults to the generic
   *                           denial message so callers cannot leak which field
   *                           was wrong)
   * @param {number} [status]  HTTP status the route should surface (default 401)
   */
  constructor(message = GENERIC_AUTH_MESSAGE, status = 401) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}
