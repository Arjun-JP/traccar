FROM node:22-alpine

# Set the working directory
WORKDIR /app

# Copy the webhook-bridge files
COPY webhook-bridge/package*.json ./
RUN npm install

COPY webhook-bridge/ ./

# Expose the TCP port
EXPOSE 5112

# Run the server
CMD ["npx", "ts-node", "server.ts"]
