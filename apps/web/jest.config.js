module.exports = {
  testEnvironment: 'node',
  moduleFileExtensions: ['js', 'jsx', 'ts', 'tsx'],
  transform: {
    '^.+\\.[jt]sx?$': 'babel-jest'
  },
  collectCoverageFrom: ['lib/**/*.js', 'components/**/*.js', 'app/api/**/*.js', 'middleware.ts'],
  roots: ['<rootDir>/tests'],
  testPathIgnorePatterns: ['/tests/e2e/']
};
