FROM node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d
ARG SOURCE_REVISION=unpublished
ARG SOURCE_REPOSITORY=unpublished
ARG SOURCE_TREE_SHA256=unpublished
LABEL org.opencontainers.image.revision=$SOURCE_REVISION \
      org.opencontainers.image.source=$SOURCE_REPOSITORY \
      org.opencontainers.image.licenses=Apache-2.0 \
      org.livingwire.source-tree-sha256=$SOURCE_TREE_SHA256
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY *.js ./
COPY LICENSE NOTICE ./
USER node
CMD ["node", "runtime.js"]
