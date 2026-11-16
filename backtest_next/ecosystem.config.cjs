// PM2: chạy bản build của Next.js (dùng được cả Windows lẫn Linux)
//   npm run build  ->  pm2 start ecosystem.config.cjs  ->  pm2 save
module.exports = {
  apps: [
    {
      name: 'backtest',
      cwd: __dirname,
      script: 'node_modules/next/dist/bin/next', // gọi thẳng Next, không qua npm (Windows chạy ổn định hơn)
      args: 'start -p 3002',                      // đổi cổng ở đây nếu trùng
      exec_mode: 'fork',                          // 1 tiến trình: cache tick nằm trong RAM của tiến trình
      instances: 1,
      autorestart: true,
      max_memory_restart: '3G',                   // RAM vượt 3 GB thì tự khởi động lại
      node_args: '--max-old-space-size=4096',
      env: { NODE_ENV: 'production' },
      out_file: './logs/out.log',
      error_file: './logs/error.log',
      time: true,                                 // log có kèm thời gian
    },
  ],
};