import { z } from 'zod';

/** Every export is fully defined by the signed-in reader; no query parameter is accepted. */
export const exportQuerySchema = z.strictObject({});
