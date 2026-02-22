FROM denoland/deno:alpine AS build
WORKDIR /app
COPY deno.json deno.lock ./
COPY src/ src/
COPY scripts/ scripts/
RUN deno install && deno task build:static

FROM denoland/deno:alpine
WORKDIR /app
COPY --from=build /app/deno.json /app/deno.lock ./
COPY --from=build /app/src/ src/
RUN deno cache src/index.ts
VOLUME /data
EXPOSE 3000
ENV DB_URL="file:/data/tickets.db"
ENV ALLOWED_DOMAIN="localhost"
CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-read", "--allow-write", "--allow-sys", "--allow-ffi", "src/index.ts"]
