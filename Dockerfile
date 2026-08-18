FROM node:22-alpine

WORKDIR /app

COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public

RUN mkdir -p /data && chown node:node /data

USER node

ENV NODE_ENV=production
ENV PORT=3000
ENV FAULTLINE_DATA_FILE=/data/faultline.json

EXPOSE 3000

CMD ["node", "src/server.mjs"]
