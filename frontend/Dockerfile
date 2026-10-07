# The control room, running the Vite dev server — this image is for looking at the app,
# not for serving production traffic (a static build behind a real web server is the
# deployment story, and it is not pretended to exist yet).
#
#   docker build -t crew-frontend ./frontend
#   docker run -p 5173:5173 crew-frontend
FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# The API base is read by the BROWSER, so it must be an address the browser can reach —
# the host's localhost, not the container's.
ENV VITE_API_BASE=http://127.0.0.1:8787

EXPOSE 5173

CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "5173"]
