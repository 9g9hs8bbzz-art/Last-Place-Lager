process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL || 'postgresql://fcp:fcp@localhost:5432/fcp_test?schema=public';
process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = 'test-access-secret';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';
