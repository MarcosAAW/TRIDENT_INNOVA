module.exports = {
  testEnvironment: 'node',
  testTimeout: 20000,
  setupFiles: [
    '<rootDir>/tests/helpers/loadTestEnv.js',
    '<rootDir>/tests/helpers/ensureSafeTestDb.js'
  ]
};
