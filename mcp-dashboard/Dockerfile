FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY datasources.example.json ./
ENV PORT=3000 DATA_FILE=/data/dashboards.json DATASOURCES_FILE=/data/datasources.json
VOLUME /data
EXPOSE 3000
CMD ["node", "src/server.js"]
