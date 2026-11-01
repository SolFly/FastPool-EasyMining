FROM golang:1.27.3-alpine AS build
RUN apk add --no-cache build-base
WORKDIR /src
COPY go.mod go.sum ./
COPY vendor ./vendor
COPY assets.go ./
COPY cmd ./cmd
COPY internal ./internal
COPY public ./public
RUN CGO_ENABLED=1 go build -mod=vendor -tags 'netgo osusergo sqlite_omit_load_extension' -trimpath -ldflags '-s -w -linkmode external -extldflags -static' -o /out/easymining ./cmd/easymining

FROM alpine:3.22
RUN apk add --no-cache ca-certificates tzdata && addgroup -g 1000 app && adduser -D -u 1000 -G app app && mkdir -p /data && chown app:app /data
ENV HOST=0.0.0.0 PORT=8080 DATA_DIR=/data
COPY --from=build /out/easymining /usr/local/bin/easymining
USER app
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD ["easymining","--healthcheck"]
CMD ["easymining"]
