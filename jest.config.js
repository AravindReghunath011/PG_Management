module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/src/tests/setupEnv.ts'],
  testMatch: ['**/tests/**/*.test.ts', '**/?(*.)+(spec|test).ts'],
  verbose: true,
  forceExit: true,
  clearMocks: true,
  resetMocks: true,
  restoreMocks: true
};
