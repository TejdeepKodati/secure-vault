# Secure Vault - no build step and no dependencies, so the image is just Node plus the source.
FROM node:22-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data

WORKDIR /app
COPY package.json server.js ./
COPY src ./src
COPY public ./public

# The vault lives on a volume. Ownership is set before VOLUME so a fresh named
# volume inherits it and the unprivileged user can write to it.
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# JWT_SECRET is required in production and is deliberately NOT baked into the image:
#   docker run -d -p 3000:3000 -v vault-data:/data -e JWT_SECRET=... vault
CMD ["node", "server.js"]
