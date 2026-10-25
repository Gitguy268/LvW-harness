# LvW-harness server image: the lvw binary, a CPU llama-server and headless Chromium.
# docker compose up -d   (see docker-compose.yml)   or   docker build --build-arg WITH_BROWSER=0 -t lvw .
FROM oven/bun:1.4.3 AS build
WORKDIR /src
COPY package.json bun.lock bunfig.toml tsconfig.json ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY scripts ./scripts
RUN bun scripts/build.ts

FROM debian:bookworm-slim
ARG WITH_BROWSER=1
ARG LLAMA_TAG=
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git libgomp1 libcurl4 tar \
    $([ "$WITH_BROWSER" = 1 ] && echo chromium fonts-liberation) \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/dist/lvw /usr/local/bin/lvw
# Bake llama-server into the image so the data volume holds only models and state.
RUN LVW_HOME=/tmp/lvw lvw runtime install ${LLAMA_TAG:+--tag=$LLAMA_TAG} \
 && mv /tmp/lvw/runtime/llama.cpp/b* /opt/llama.cpp && rm -rf /tmp/lvw \
 && ln -s "$(dirname "$(find /opt/llama.cpp -name llama-server -type f)")" /opt/llama.cpp/bin-dir
ENV PATH=/opt/llama.cpp/bin-dir:$PATH \
    LVW_HOME=/data
RUN useradd --create-home --uid 1000 lvw && mkdir -p /data /work && chown lvw:lvw /data /work
USER lvw
WORKDIR /work
VOLUME /data
EXPOSE 7878
ENTRYPOINT ["lvw"]
CMD ["serve", "--host", "0.0.0.0"]
