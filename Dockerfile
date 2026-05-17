FROM node:20-alpine

RUN apk add --no-cache python3 make g++ linux-headers

WORKDIR /app/backend

COPY backend/package*.json ./
COPY backend/.npmrc        ./

RUN CXXFLAGS="-std=c++20" npm install --omit=dev

COPY backend/  ./
COPY frontend/ ../frontend/

EXPOSE 3000
CMD ["node", "server.js"]
