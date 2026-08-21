FROM node:22-alpine

WORKDIR /app

COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
# Runtime data, not test data: src/recorder/simulate.mjs loads these scenarios
# through loadScenario()/listScenarios(). Without them /api/recorder/scenarios
# is empty and the Flight Recorder cannot replay a simulation.
COPY --chown=node:node fixtures ./fixtures

RUN mkdir -p /data && chown node:node /data

USER node

ENV NODE_ENV=production
ENV PORT=3000
ENV FAULTLINE_DATA_FILE=/data/faultline.json

EXPOSE 3000

CMD ["node", "src/server.mjs"]
