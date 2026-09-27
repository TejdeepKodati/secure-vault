/**
 * A very small Express-shaped router built on node:http.
 *
 * Deliberately mirrors Express's `(req, res, next)` middleware contract and its
 * `res.status().json()` helpers, so the route modules read like ordinary Express
 * code and swapping the real framework back in is a mechanical change confined
 * to this file and server.js (SRS 3: equivalents are permitted where observable
 * behaviour is unchanged).
 *
 * Supported: global and path-prefixed middleware, method routes with `:params`,
 * async handlers (a rejected promise becomes `next(err)`), and error handlers.
 */
const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

function compileMatcher(pattern) {
  if (!pattern.includes(':')) {
    return (pathname) => (pathname === pattern ? {} : null);
  }
  const keys = [];
  const source = pattern
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) {
        keys.push(segment.slice(1));
        return '([^/]+)';
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  const regex = new RegExp(`^${source}$`);
  return (pathname) => {
    const match = regex.exec(pathname);
    if (!match) return null;
    const params = {};
    keys.forEach((key, index) => {
      try {
        params[key] = decodeURIComponent(match[index + 1]);
      } catch {
        params[key] = match[index + 1];
      }
    });
    return params;
  };
}

export function createApp({ onError } = {}) {
  const layers = [];
  const errorHandlers = [];

  const app = {
    /** `use(fn)` for every request, or `use('/prefix', fn)` to scope it. */
    use(first, ...rest) {
      if (typeof first === 'function') {
        layers.push({ method: null, match: () => ({}), handler: first });
        return app;
      }
      for (const handler of rest) {
        layers.push({
          method: null,
          match: (pathname) => (pathname === first || pathname.startsWith(`${first}/`) ? {} : null),
          handler,
        });
      }
      return app;
    },

    useError(handler) {
      errorHandlers.push(handler);
      return app;
    },

    handle(req, res) {
      let index = 0;
      let finished = false;

      const runErrorHandlers = (err) => {
        let errorIndex = 0;
        const nextError = (nextErr) => {
          const handler = errorHandlers[errorIndex++];
          if (!handler) {
            onError?.(nextErr, req, res);
            return;
          }
          try {
            const result = handler(nextErr, req, res, nextError);
            if (result && typeof result.catch === 'function') result.catch(nextError);
          } catch (thrown) {
            nextError(thrown);
          }
        };
        nextError(err);
      };

      const next = (err) => {
        if (err) {
          if (finished) return;
          finished = true;
          runErrorHandlers(err);
          return;
        }
        const layer = layers[index++];
        if (!layer) {
          if (!finished) {
            finished = true;
            runErrorHandlers(Object.assign(new Error('Not found'), { status: 404, code: 'NOT_FOUND', expose: true, message: 'That endpoint does not exist.' }));
          }
          return;
        }
        if (layer.method && layer.method !== req.method) return next();
        const params = layer.match(req.path);
        if (!params) return next();
        req.params = params;
        try {
          const result = layer.handler(req, res, next);
          if (result && typeof result.catch === 'function') result.catch(next);
        } catch (thrown) {
          next(thrown);
        }
      };

      next();
    },
  };

  for (const method of METHODS) {
    app[method] = (pattern, ...handlers) => {
      const match = compileMatcher(pattern);
      for (const handler of handlers) {
        layers.push({ method: method.toUpperCase(), match, handler });
      }
      // HEAD must follow GET routing so the browser can probe resources.
      if (method === 'get') {
        for (const handler of handlers) {
          layers.push({ method: 'HEAD', match, handler });
        }
      }
      return app;
    };
  }

  return app;
}
