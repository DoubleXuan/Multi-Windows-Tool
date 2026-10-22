const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
    testDir: './test/ui',
    fullyParallel: true,
    workers: 2,
    timeout: 30000,
    use: { baseURL: 'http://127.0.0.1:4173', viewport: { width: 1440, height: 1000 }, trace: 'retain-on-failure' },
    webServer: { command: 'node test/ui/server.cjs', url: 'http://127.0.0.1:4173', reuseExistingServer: false }
});
