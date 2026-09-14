# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1 - build: compile the TypeScript sources into dist/
# ---------------------------------------------------------------------------
FROM node:lts-alpine AS build
WORKDIR /app

# Install all dependencies (including the TypeScript toolchain) from the
# lockfile. Install scripts are skipped: the only one (snyk's postinstall)
# downloads a binary that is not needed to build the package.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2 - runtime: production dependencies + compiled output only
# ---------------------------------------------------------------------------
FROM node:lts-alpine
WORKDIR /app

ENV NODE_ENV=production
# Colours are enabled by chalk only when attached to a TTY; keep the default
# behaviour so that `docker run -t` gets colours and piped output does not.

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=build /app/dist ./dist

# Run as the unprivileged user that ships with the official Node image.
# /work is where mounted input/output files and user scripts are expected:
#   docker run --rm -v "$PWD:/work" sqs-grep --inputFile messages.txt --all
USER node
WORKDIR /work
VOLUME ["/work"]

ENTRYPOINT ["node", "/app/dist/main.js"]
CMD ["--help"]
