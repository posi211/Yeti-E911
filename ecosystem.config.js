module.exports = { apps: [
  { name: 'yeti-e911-web',     script: 'server.js',  env_file: '.env', node_args: '--env-file=.env' },
  { name: 'yeti-e911-watcher', script: 'watcher.js', env_file: '.env', node_args: '--env-file=.env' } ] };
