module.exports = {
  apps: [
    {
      name: 'watapp-server',
      cwd: './server',
      script: 'index.js',
      watch: false,
      restart_delay: 3000,
      max_restarts: 20,
      env: {
        PORT: 10001,
        // Set your key in the shell before `pm2 start`, or use:
        //   pm2 set watapp-server:ANTHROPIC_API_KEY sk-ant-...
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
      },
    },
    {
      name: 'watapp-web',
      cwd: './web',
      script: 'node_modules/.bin/next',
      args: 'dev -p 10000',
      watch: false,
      restart_delay: 3000,
      max_restarts: 20,
    },
  ],
};
