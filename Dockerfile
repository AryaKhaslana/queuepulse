# Stage 1: Build React + TypeScript dashboard
FROM node:22-alpine AS web-builder
WORKDIR /src/web
COPY web/package.json web/package-lock.json* ./
RUN npm ci
COPY web/ ./
RUN npm run build

# Stage 2: Build static Go single binary with embedded UI
FROM golang:1.24-alpine AS go-builder
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN rm -rf webembed/dist && mkdir -p webembed/dist && cp -R /src/web/dist/* webembed/dist/
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /out/queuepulse ./cmd/queuepulse

# Stage 3: Minimal runtime image
FROM alpine:3.21
RUN apk add --no-cache ca-certificates ffmpeg
WORKDIR /data
COPY --from=go-builder /out/queuepulse /usr/local/bin/queuepulse
EXPOSE 8080
ENTRYPOINT ["queuepulse", "-addr", ":8080", "-db", "/data/queuepulse.db", "-workers", "3"]
