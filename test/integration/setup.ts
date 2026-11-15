import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { APPLICATION_MODELS } from '../../src/db/application-models.js';
import { connectToTestDatabase } from './test-database.js';

const models = APPLICATION_MODELS.map(({ modelName }) => mongoose.model(modelName));

async function deleteEveryDocument(): Promise<void> {
  await Promise.all(models.map((model) => model.deleteMany({})));
}

// syncIndexes drops indexes the schemas do not define: acceptable only on the guarded test database.
beforeAll(async () => {
  await connectToTestDatabase();
  await Promise.all(models.map((model) => model.syncIndexes()));
});

beforeEach(async () => {
  await deleteEveryDocument();
});

afterAll(async () => {
  await deleteEveryDocument();
  await mongoose.disconnect();
});
