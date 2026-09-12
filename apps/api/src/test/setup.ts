import os from 'node:os';
import path from 'node:path';

process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL || 'postgresql://fcp:fcp@localhost:5432/fcp_test?schema=public';
process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = 'test-access-secret';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';

// Configuration is read once when lib/env.ts is first imported, which happens
// before any beforeAll hook runs. Uploads therefore have to be pointed at a
// scratch directory here rather than inside a test.
process.env.UPLOAD_DIR = path.join(os.tmpdir(), `fcp-test-uploads-${process.pid}`);
