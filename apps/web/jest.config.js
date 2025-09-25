module.exports = {
  testEnvironment: 'node',
  moduleFileExtensions: ['js', 'jsx'],
  transform: {
    '^.+\\.[jt]sx?$': 'babel-jest'
  },
  collectCoverageFrom: ['lib/**/*.js', 'components/**/*.js'],
  roots: ['<rootDir>/tests']
};
