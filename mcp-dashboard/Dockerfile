FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
ENV PORT=3000 DATA_FILE=/data/dashboards.json
VOLUME /data
EXPOSE 3000
CMD ["node", "src/server.js"]
