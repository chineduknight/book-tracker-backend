# Operations runbook

Procedures for operators with direct database access. None of these are API features, and none
should be automated as user-facing actions.

## Book stuck as physical after a failed copy insert

**Background.** Adding a physical copy first marks the parent book with the internal field
`hasPhysicalCopyHistory: true`, then inserts the copy (see
[decisions.md](decisions.md#physical-copy-and-location-decisions)). If the insert fails after the
mark (for example the database became unreachable between the two writes), the book may have the
flag but no copy. The reader then gets `409 BOOK_HAS_PHYSICAL_COPIES` when changing the book to an
ebook. This fails closed: no data is wrong, the book just cannot become an ebook.

**Diagnose** (read-only, safe at any time). Books that are flagged but have no copy record at
all, including deleted copies:

```js
db.books.aggregate([
  { $match: { hasPhysicalCopyHistory: true } },
  { $lookup: { from: 'physicalcopies', localField: '_id', foreignField: 'bookId', as: 'copies' } },
  { $match: { copies: { $size: 0 } } },
  { $project: { _id: 1, ownerId: 1, format: 1, deletedAt: 1 } },
]);
```

A book with any copy record (even a deleted one) is **not** stranded: deleted copies count as
history on purpose, because future loans may reference them. Never clear the flag for such a book.

**Recover** only a book from the diagnosis, and only with the API stopped or in maintenance mode.
The check and the change below cannot be made atomic without transactions; if the API is running,
a copy could be created between them and the book could then become an ebook with a copy.

1. Stop the API (or block writes to it) and confirm no instance is serving requests.
2. Re-check the specific book has no copy records:

   ```js
   const bookId = ObjectId('<book id>');
   db.physicalcopies.countDocuments({ bookId }); // must be 0
   ```

3. Clear the flag only if it is still set:

   ```js
   db.books.updateOne(
     { _id: bookId, hasPhysicalCopyHistory: true },
     { $set: { hasPhysicalCopyHistory: false } },
   );
   ```

4. Start the API again. The reader can now change the book's format.

Record the book id, time and operator. Do not change `updatedAt` or any other field.
