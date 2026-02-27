FROM node:22-alpine AS frontend-build
WORKDIR /app/web
COPY web/package.json web/package-lock.json* ./
RUN npm install
COPY web/ ./
RUN npm run build

FROM golang:1.23-alpine AS backend-build
RUN apk add --no-cache git
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=frontend-build /app/web/dist ./web/dist
RUN CGO_ENABLED=0 GOOS=linux go build -o /hubble-gazer .

FROM gcr.io/distroless/static-debian12
COPY --from=backend-build /hubble-gazer /hubble-gazer
EXPOSE 3000
ENTRYPOINT ["/hubble-gazer"]
