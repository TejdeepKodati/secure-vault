/**
 * Application errors (SRS 26).
 *
 * `message` is the safe, user-facing text sent to the client. Anything that
 * would leak implementation detail - absolute paths, stack traces, syscall
 * names - belongs in `detail`, which is logged server-side and never
 * serialised into a response.
 */
export class AppError extends Error {
  constructor(status, code, message, detail) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.expose = true;
    this.detail = detail;
  }
}

export const badRequest = (message = 'The request was not valid.', detail) =>
  new AppError(400, 'BAD_REQUEST', message, detail);

export const unauthorized = (message = 'Authentication required.', detail) =>
  new AppError(401, 'UNAUTHORIZED', message, detail);

export const forbidden = (message = 'That action is not allowed.', detail) =>
  new AppError(403, 'FORBIDDEN', message, detail);

export const notFound = (message = 'That item could not be found.', detail) =>
  new AppError(404, 'NOT_FOUND', message, detail);

export const conflict = (message = 'That item already exists.', detail) =>
  new AppError(409, 'CONFLICT', message, detail);

export const payloadTooLarge = (message = 'That upload is too large.', detail) =>
  new AppError(413, 'PAYLOAD_TOO_LARGE', message, detail);

export const unsupportedMedia = (message = 'That file type is not supported.', detail) =>
  new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', message, detail);

export const tooManyRequests = (message = 'Too many attempts.', detail, retryAfter) => {
  const err = new AppError(429, 'TOO_MANY_REQUESTS', message, detail);
  err.retryAfter = retryAfter;
  return err;
};

export const serverError = (message = 'Something went wrong on the server.', detail) =>
  new AppError(500, 'INTERNAL_ERROR', message, detail);

/**
 * Translate a raw filesystem error into a safe AppError. Node's fs errors carry
 * absolute paths in `err.path`, so they must never reach the client verbatim
 * (SRS 24: do not expose internal server filesystem paths).
 */
export function fromFsError(err, fallbackMessage = 'That file operation failed.') {
  // An AppError has already been given a safe status, code and message - usually
  // by a validation check that ran inside the same try block as the filesystem
  // call. Re-translating it would downgrade a deliberate 400 into a generic 500.
  if (err instanceof AppError) return err;

  switch (err?.code) {
    case 'ENOENT':
      return notFound('That item no longer exists.', err.message);
    case 'EEXIST':
      return conflict('An item with that name already exists.', err.message);
    case 'ENOTEMPTY':
      return conflict('That folder is not empty.', err.message);
    case 'EACCES':
    case 'EPERM':
      return forbidden('The server is not permitted to touch that item.', err.message);
    case 'EISDIR':
      return badRequest('That item is a folder, not a file.', err.message);
    case 'ENOTDIR':
      return badRequest('That path is not a folder.', err.message);
    case 'ENOSPC':
      return new AppError(507, 'NO_SPACE', 'The server has run out of storage space.', err.message);
    case 'EMFILE':
    case 'ENFILE':
      return new AppError(503, 'BUSY', 'The server is busy. Please try again.', err.message);
    default:
      return serverError(fallbackMessage, err?.message);
  }
}
