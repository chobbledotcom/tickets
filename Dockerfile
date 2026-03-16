FROM denoland/deno:alpine-2.3.3 AS build
WORKDIR /app
COPY deno.json deno.lock ./
COPY src/ src/
COPY scripts/ scripts/
RUN deno install && deno task build:static

FROM denoland/deno:alpine-2.3.3
WORKDIR /app

# Create non-root user for running the application
RUN addgroup -S tickets && adduser -S tickets -G tickets \
    && mkdir -p /data && chown tickets:tickets /data

COPY --from=build /app/deno.json /app/deno.lock ./
COPY --from=build /app/src/ src/
RUN deno cache src/index.ts

VOLUME /data
EXPOSE 3000

ENV DB_URL="file:/data/tickets.db"

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["deno", "eval", "const r = await fetch('http://localhost:3000/'); if (!r.ok) Deno.exit(1);"]

USER tickets

CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-read", "--allow-write=/data", "--allow-sys", "--allow-ffi", "src/index.ts"]
