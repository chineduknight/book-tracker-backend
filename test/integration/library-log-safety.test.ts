import { describe, expect, it } from 'vitest';
import { createLogger } from '../../src/config/logger.js';
import { createLogCapture } from '../helpers.js';
import { createAuthTestApp } from './auth-fixtures.js';
import { addCopy, addLocation, addPhysicalBook, signInLibraryReader } from './library-fixtures.js';

describe('catalogue logging', () => {
  it('never writes titles, location names or copy notes to the logs', async () => {
    const logs = createLogCapture();
    const reader = await signInLibraryReader(
      createAuthTestApp({ logger: createLogger('trace', logs.stream) }),
    );
    const book = await addPhysicalBook(reader, 'Secret Diary Title');
    const location = await addLocation(reader, 'Hidden Safe Room', 'Behind the painting');
    await addLocation(reader, 'Second Room');
    await reader.locations.create({ name: 'hidden safe room' });
    const copy = await addCopy(reader, book.id, {
      label: 'Private label',
      storageNote: 'Under the floorboard',
      locationId: location.id,
    });
    await reader.copies.update(copy.id, { storageNote: 'Inside the piano' });
    await reader.books.list({ q: 'diary' });

    const output = logs.output();
    expect(output).toContain('"path":"/api/v1/locations"');
    for (const privateText of [
      'Secret Diary',
      'Hidden Safe Room',
      'hidden safe room',
      'Behind the painting',
      'Private label',
      'Under the floorboard',
      'Inside the piano',
      'diary',
    ]) {
      expect(output).not.toContain(privateText);
    }
  });
});
