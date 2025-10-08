# ----- Giai đoạn 1: Build -----
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
# Nếu bạn dùng TypeScript, thêm lệnh build ở đây: RUN npm run build

# ----- Giai đoạn 2: Production -----
FROM node:20-alpine AS production
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY --from=builder /app .
# Nếu có bước build, hãy sao chép thư mục build: COPY --from=builder /app/dist ./dist

# Mở port mà ứng dụng đang lắng nghe BÊN TRONG container
EXPOSE 4010

# Lệnh để khởi chạy ứng dụng (giả sử file chính là server.js)
CMD ["node", "server.js"]