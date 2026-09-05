# Landfall — one image, two roles.
#
# The indexer and the API share a lockfile and most of their dependency tree,
# so building them twice would double the build time to save nothing. The
# command decides which one runs:
#
#   docker run landfall                      # API on :8787
#   docker run landfall npm run scan ...     # one scan, then exit
#
# Deliberately not a distroless multi-stage build. There is no compile step —
# tsx runs the TypeScript directly — and a debuggable image matters more here
# than fifty megabytes. If image size ever becomes the problem, that is the
# moment to add the stage, not before.

FROM node:22-alpine

# Horizon over TLS needs a CA bundle; the slim node images do not carry one.
# `wget` and `curl` are the healthcheck.
RUN apk add --no-cache ca-certificates curl && update-ca-certificates

WORKDIR /app
ENV NODE_ENV=production

# Copy the manifests first so a source change does not invalidate the
# dependency layer.
COPY package.json package-lock.json ./
COPY packages/indexer/package.json packages/indexer/
COPY packages/api/package.json     packages/api/

# `--include=dev` because tsx is a devDependency and is what actually runs the
# process. Naming that here is cheaper than pretending it is a runtime dep.
RUN npm ci --include=dev --no-audit --no-fund

COPY packages/ packages/

# Never run as root. Node's own `node` user already exists in this image.
RUN mkdir -p /app/out && chown -R node:node /app
USER node

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://localhost:${PORT:-8787}/health" || exit 1

CMD ["npm", "run", "start", "-w", "@landfall/api"]
