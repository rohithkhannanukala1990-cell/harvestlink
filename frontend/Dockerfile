# Harvestlink frontend — multi-stage production image.
#
# Stage "build": install dependencies and run Vite to emit static assets into dist/.
# Vite, TypeScript, Tailwind, and oxlint are build-time only.
#
# Stage "runtime": nginx serves the static files. Why no Node/devDependencies here:
# the browser only needs HTML/JS/CSS. Shipping npm, vite, or typescript in production
# would bloat the image and add unused attack surface with no runtime benefit.

# ---------- build stage ----------
FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY index.html ./
COPY vite.config.ts tsconfig.json tsconfig.app.json tsconfig.node.json ./
COPY public ./public
COPY src ./src

# VITE_* vars are baked in at build time (not read by nginx at runtime).
ARG VITE_API_URL=http://localhost:3001
ENV VITE_API_URL=$VITE_API_URL

RUN npm run build

# ---------- runtime stage ----------
FROM nginx:1.27-alpine AS runtime

# SPA fallback so React Router paths like /pos load index.html.
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
