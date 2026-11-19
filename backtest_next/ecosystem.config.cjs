// PM2: chạy bản build của Next.js (dùng được cả Windows lẫn Linux)
//   npm run build  ->  pm2 start ecosystem.config.cjs  ->  pm2 save
const fs = require('fs');
const path = require('path');

// Đọc .env nằm cạnh file này và truyền thẳng cho app,
// để không phụ thuộc PM2 chạy ở thư mục nào.
function loadEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) {
    console.warn(`[ecosystem] Không thấy ${file}`);
    return out;
  }
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    out[key] = val;
  }
  return out;
}

module.exports = {
  apps: [
    {
      name: 'backtest',
      cwd: __dirname,
      script: 'node_modules/next/dist/bin/next', // gọi thẳng Next, không qua npm
      args: 'start -p 3000',                      // đổi cổng ở đây nếu trùng
      exec_mode: 'fork',                          // 1 tiến trình: cache tick nằm trong RAM
      instances: 1,
      autorestart: true,
      max_memory_restart: '6G',                   // backtest nhiều tháng cần nhiều RAM
      node_args: '--max-old-space-size=4096',
      env: { NODE_ENV: 'production', ...loadEnv(path.join(__dirname, '.env')) },
      out_file: './logs/out.log',
      error_file: './logs/error.log',
      time: true,
    },
  ],
};
