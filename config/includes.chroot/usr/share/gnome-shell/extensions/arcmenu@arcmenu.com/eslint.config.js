import gjsConfig from './lint/eslintrc-gjs.config.js';
import gnomeShellConfig from './lint/eslintrc-shell.config.js';

export default [
    ...gjsConfig,
    ...gnomeShellConfig,
];
