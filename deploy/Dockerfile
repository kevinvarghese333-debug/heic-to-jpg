# syntax=docker/dockerfile:1

# Two stages: build the static site, then serve it from nginx. The runtime
# image carries no toolchain — just nginx and the built files.
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# The ONNX runtime and the model are deliberately NOT in git — they are 51MB of
# binaries. They are assembled here instead, so a build from a clean checkout is
# reproducible and nothing large has to be committed or copied up by hand.
#
# Exactly three runtime files. The webgpu build references the *asyncify* wasm;
# copying the whole dist folder would ship 76MB of unused variants.
RUN mkdir -p public/ort public/models \
 && cp node_modules/onnxruntime-web/dist/ort.webgpu.bundle.min.mjs public/ort/ \
 && cp node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs public/ort/ \
 && cp node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm public/ort/

ARG MODEL_URL="https://huggingface.co/darktable-org/upscale-realplksr-onnx/resolve/main/onnx/model_x2.onnx"
RUN apk add --no-cache curl \
 && curl -fsSL --retry 3 -o public/models/realplksr_x2.onnx "$MODEL_URL" \
 && test -s public/models/realplksr_x2.onnx

# Where the app will be served from. Baked in at build time because Vite
# rewrites asset URLs with it; see vite.config.ts.
ARG APP_BASE=/heic/
ENV APP_BASE=$APP_BASE
RUN npm run build

FROM nginx:1.27-alpine
COPY deploy/nginx-container.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1/index.html >/dev/null || exit 1
EXPOSE 80
