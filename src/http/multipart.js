import { badRequest, payloadTooLarge } from '../util/errors.js';

/**
 * Streaming multipart/form-data parser (RFC 7578).
 *
 * File bytes are handed to the caller's sink as they arrive and never buffered
 * whole, so a multi-gigabyte upload costs a chunk of memory rather than its own
 * size. Backpressure is honoured: the request stream is consumed with
 * `for await`, so awaiting a slow disk write pauses the socket.
 *
 * Parts are delivered strictly in wire order, which lets the upload route pair
 * each file with the `relativePath` field that precedes it and reconstruct an
 * uploaded folder hierarchy (SRS 7).
 */

const MAX_HEADER_BYTES = 16 * 1024;
const MAX_PART_HEADER_SEARCH = 64 * 1024;

export function boundaryFrom(contentTypeHeader) {
  const header = String(contentTypeHeader || '');
  if (!header.toLowerCase().startsWith('multipart/form-data')) return null;
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(header);
  const boundary = (match?.[1] ?? match?.[2] ?? '').trim();
  if (!boundary || boundary.length > 200) return null;
  return boundary;
}

/** Decode one `name="value"` / `name*=UTF-8''value` parameter set. */
function parseParams(text) {
  const params = {};
  const re = /;\s*([\w*-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;"]*))/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    const key = match[1].toLowerCase();
    let value = match[2] !== undefined ? match[2].replace(/\\(.)/g, '$1') : (match[3] || '').trim();
    if (key.endsWith('*')) {
      // RFC 5987: charset'language'percent-encoded-value
      const extended = /^([\w-]*)'[\w-]*'(.*)$/.exec(value);
      if (extended) {
        try {
          value = decodeURIComponent(extended[2]);
        } catch {
          value = extended[2];
        }
      }
      params[key.slice(0, -1)] = value;
    } else if (params[key] === undefined) {
      params[key] = value;
    }
  }
  return params;
}

function parsePartHeaders(raw) {
  const headers = {};
  for (const line of raw.split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon < 1) continue;
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  const disposition = headers['content-disposition'];
  if (!disposition || !/^form-data/i.test(disposition)) {
    throw badRequest('The upload was malformed.', 'part without form-data content-disposition');
  }
  const params = parseParams(disposition);
  return {
    name: params.name ?? '',
    filename: params.filename,
    contentType: headers['content-type'],
  };
}

/**
 * @param req                 incoming request, positioned at the body
 * @param opts.boundary       multipart boundary
 * @param opts.limits         { maxFileBytes, maxTotalBytes, maxFiles, maxFields, maxFieldBytes }
 * @param opts.onField        (name, value) => void
 * @param opts.onFileStart    ({ name, filename, contentType }) => sink
 *                            sink: { write(buf): Promise<void>, finish(): Promise<void>, abort(): Promise<void> }
 * @param opts.onFileEnd      (sink, { bytes }) => Promise<void>
 */
export async function parseMultipart(req, opts) {
  const { boundary, limits, onField, onFileStart, onFileEnd } = opts;
  const maxFileBytes = limits?.maxFileBytes ?? Infinity;
  const maxTotalBytes = limits?.maxTotalBytes ?? Infinity;
  const maxFiles = limits?.maxFiles ?? Infinity;
  const maxFields = limits?.maxFields ?? 1000;
  const maxFieldBytes = limits?.maxFieldBytes ?? 64 * 1024;

  const delimiter = Buffer.from(`\r\n--${boundary}`);
  const keep = delimiter.length - 1;

  // Prefixing a CRLF makes the opening boundary look like every later one.
  let buffer = Buffer.from('\r\n');
  let state = 'seek';
  let totalBytes = 0;
  let fileCount = 0;
  let fieldCount = 0;

  let sink = null;
  let sinkBytes = 0;
  let field = null;
  let fieldChunks = null;
  let fieldBytes = 0;

  const openSinks = new Set();

  const abortAll = async () => {
    for (const open of openSinks) {
      try {
        await open.abort();
      } catch {
        /* best effort cleanup */
      }
    }
    openSinks.clear();
  };

  async function drain() {
    for (;;) {
      if (state === 'done') return;

      if (state === 'seek') {
        const index = buffer.indexOf(delimiter);
        if (index === -1) {
          if (buffer.length > keep) buffer = buffer.subarray(buffer.length - keep);
          return;
        }
        buffer = buffer.subarray(index + delimiter.length);
        state = 'afterDelimiter';
        continue;
      }

      if (state === 'afterDelimiter') {
        if (buffer.length < 2) return;
        if (buffer[0] === 0x2d && buffer[1] === 0x2d) {
          state = 'done';
          return;
        }
        const crlf = buffer.indexOf('\r\n');
        if (crlf === -1) {
          if (buffer.length > 256) throw badRequest('The upload was malformed.', 'no CRLF after boundary');
          return;
        }
        buffer = buffer.subarray(crlf + 2);
        state = 'headers';
        continue;
      }

      if (state === 'headers') {
        const end = buffer.indexOf('\r\n\r\n');
        if (end === -1) {
          if (buffer.length > MAX_HEADER_BYTES) {
            throw badRequest('The upload was malformed.', 'part headers too large');
          }
          return;
        }
        if (end > MAX_PART_HEADER_SEARCH) {
          throw badRequest('The upload was malformed.', 'part headers too large');
        }
        const info = parsePartHeaders(buffer.subarray(0, end).toString('utf8'));
        buffer = buffer.subarray(end + 4);

        if (info.filename === undefined) {
          if (++fieldCount > maxFields) throw badRequest('The upload contained too many fields.');
          field = info.name;
          fieldChunks = [];
          fieldBytes = 0;
          state = 'field';
        } else if (info.filename === '') {
          // An empty file input: nothing to store, skip the part entirely.
          state = 'skip';
        } else {
          if (++fileCount > maxFiles) {
            throw payloadTooLarge(`An upload may contain at most ${maxFiles} files.`);
          }
          sink = await onFileStart(info);
          openSinks.add(sink);
          sinkBytes = 0;
          state = 'file';
        }
        continue;
      }

      const index = buffer.indexOf(delimiter);
      const available = index === -1 ? Math.max(0, buffer.length - keep) : index;
      const slice = available > 0 ? buffer.subarray(0, available) : null;

      if (state === 'file' && slice) {
        sinkBytes += slice.length;
        totalBytes += slice.length;
        if (sinkBytes > maxFileBytes) {
          throw payloadTooLarge('That file is larger than this vault allows.');
        }
        if (totalBytes > maxTotalBytes) {
          throw payloadTooLarge('That upload is larger than this vault allows.');
        }
        await sink.write(slice);
      } else if (state === 'field' && slice) {
        fieldBytes += slice.length;
        if (fieldBytes > maxFieldBytes) throw badRequest('An upload field was too large.');
        fieldChunks.push(Buffer.from(slice));
      }

      if (index === -1) {
        buffer = buffer.subarray(available);
        return;
      }

      buffer = buffer.subarray(index);
      if (state === 'file') {
        await sink.finish();
        openSinks.delete(sink);
        await onFileEnd?.(sink, { bytes: sinkBytes });
        sink = null;
      } else if (state === 'field') {
        onField?.(field, Buffer.concat(fieldChunks).toString('utf8'));
        field = null;
        fieldChunks = null;
      }
      state = 'seek';
    }
  }

  // Slack over the declared limit to allow for boundaries, part headers and a
  // trailing epilogue. Guards against a client streaming unbounded bytes that
  // never form a part and so would not be counted below.
  const maxRawBytes = maxTotalBytes === Infinity ? Infinity : maxTotalBytes + 8 * 1024 * 1024;
  let rawBytes = 0;

  try {
    for await (const chunk of req) {
      rawBytes += chunk.length;
      if (rawBytes > maxRawBytes) {
        throw payloadTooLarge('That upload is larger than this vault allows.');
      }
      // Once the closing boundary is seen, keep consuming so the connection
      // stays healthy enough to carry the response, but stop parsing.
      if (state !== 'done') {
        buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
        await drain();
      }
    }
    if (state === 'file' || state === 'field') {
      throw badRequest('The upload ended before it was complete.');
    }
  } catch (err) {
    await abortAll();
    throw err;
  }

  return { files: fileCount, fields: fieldCount, bytes: totalBytes };
}
